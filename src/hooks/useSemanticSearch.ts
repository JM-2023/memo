// Orchestrates semantic search for the feed: activates the on-device model,
// keeps the sealed vector index reconciled with the live memos, and turns
// the (debounced) query into a ranked id → score map. Everything heavy —
// model activation, embedding, ranking — happens off the render path; the
// hook only ever publishes small state transitions.

import { useEffect, useRef, useState } from "react";
import { storedModelState } from "../lib/modelLoader";
import { MODEL_MANIFEST } from "../lib/modelManifest";
import { getEmbedder, RETRIEVAL_QUERY_PREFIX, type EmbedFn } from "../lib/modelRuntime";
import {
  emptySemanticIndex,
  loadSemanticIndex,
  reconcileSemanticIndex,
  saveSemanticIndex,
  searchSemanticIndex,
  type SemanticIndex
} from "../lib/semanticIndex";
import type { Memo } from "../lib/types";

export type SemanticSearchStatus =
  | "off"
  /** Enabled, but the model isn't downloaded on this device. */
  | "model-missing"
  | "preparing"
  | "indexing"
  | "ready"
  | "error";

export interface SemanticSearchState {
  status: SemanticSearchStatus;
  /** Memos embedded vs. memos pending, while indexing. */
  progress: { done: number; total: number } | null;
  /**
   * Ranked id → score for the current query; null while semantic ranking is
   * inactive (off, empty query, or still indexing) so the feed falls back to
   * substring search.
   */
  results: ReadonlyMap<string, number> | null;
}

const QUERY_DEBOUNCE_MS = 250;
const RECONCILE_DEBOUNCE_MS = 1500;

export function useSemanticSearch(enabled: boolean, memos: readonly Memo[], query: string): SemanticSearchState {
  const [status, setStatus] = useState<SemanticSearchStatus>("off");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<ReadonlyMap<string, number> | null>(null);
  /** Bumped whenever index content changes, so the search effect re-ranks. */
  const [indexEpoch, setIndexEpoch] = useState(0);

  const embedRef = useRef<EmbedFn | null>(null);
  const indexRef = useRef<SemanticIndex | null>(null);
  const generationRef = useRef(0);
  const memosRef = useRef(memos);
  memosRef.current = memos;

  // Activation: model → persisted index → first reconcile. Disabling (or a
  // re-enable) bumps the generation, which parks any in-flight loop.
  useEffect(() => {
    if (!enabled) {
      generationRef.current += 1;
      setStatus("off");
      setProgress(null);
      setResults(null);
      return;
    }
    const generation = (generationRef.current += 1);
    const alive = () => generationRef.current === generation;
    void (async () => {
      setStatus("preparing");
      if ((await storedModelState()) !== "complete") {
        if (alive()) setStatus("model-missing");
        return;
      }
      try {
        embedRef.current = await getEmbedder();
      } catch {
        if (alive()) setStatus("error");
        return;
      }
      if (!alive()) return;
      if (!indexRef.current || indexRef.current.modelVersion !== MODEL_MANIFEST.version) {
        indexRef.current = (await loadSemanticIndex(MODEL_MANIFEST.version)) ?? emptySemanticIndex(MODEL_MANIFEST.version);
      }
      if (!alive()) return;
      setStatus("indexing");
      const embed = embedRef.current;
      const reconciled = await reconcileSemanticIndex(indexRef.current, memosRef.current, embed, {
        onProgress: (done, total) => {
          if (alive()) setProgress(total > 0 ? { done, total } : null);
        },
        shouldContinue: alive,
        onFlush: (partial) => {
          indexRef.current = partial;
          return saveSemanticIndex(partial);
        }
      });
      if (reconciled !== indexRef.current) {
        indexRef.current = reconciled;
        await saveSemanticIndex(reconciled);
      }
      if (!alive()) return;
      setProgress(null);
      setIndexEpoch((epoch) => epoch + 1);
      setStatus("ready");
    })();
  }, [enabled]);

  // Later syncs and edits: fold changes in quietly once the dust settles.
  useEffect(() => {
    if (!enabled || status !== "ready") return;
    const generation = generationRef.current;
    const alive = () => generationRef.current === generation;
    const timer = window.setTimeout(() => {
      const embed = embedRef.current;
      const index = indexRef.current;
      if (!embed || !index) return;
      void (async () => {
        const reconciled = await reconcileSemanticIndex(index, memosRef.current, embed, { shouldContinue: alive });
        if (!alive() || reconciled === index) return;
        indexRef.current = reconciled;
        await saveSemanticIndex(reconciled);
        if (alive()) setIndexEpoch((epoch) => epoch + 1);
      })();
    }, RECONCILE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, status, memos]);

  // Query → ranked results, debounced past keystrokes and embed latency.
  useEffect(() => {
    if (!enabled || status !== "ready") {
      setResults(null);
      return;
    }
    const trimmed = query.trim();
    if (!trimmed) {
      setResults(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const embed = embedRef.current;
      const index = indexRef.current;
      if (!embed || !index) return;
      void (async () => {
        try {
          const [vector] = await embed([RETRIEVAL_QUERY_PREFIX + trimmed]);
          if (!cancelled) setResults(searchSemanticIndex(index, vector));
        } catch {
          if (!cancelled) setResults(null);
        }
      })();
    }, QUERY_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, status, query, indexEpoch]);

  return { status, progress, results };
}
