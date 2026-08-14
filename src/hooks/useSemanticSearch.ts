// Orchestrates semantic search for the feed: activates the on-device model,
// keeps the sealed vector index reconciled with the live memos, and turns
// the (debounced) query into a ranked id → score map. The first build exposes
// consistent partial indexes batch by batch, so the feed can add semantic
// matches progressively while ordinary keyword search remains available.
// Everything heavy — model activation, embedding, ranking — happens off the
// render path; the hook only ever publishes small state transitions.

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
   * inactive or has no searchable rows yet. The feed always keeps keyword
   * matching active and merges this map when it is available.
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
  const queryRef = useRef(query);
  queryRef.current = query;
  const queryVectorRef = useRef<{ query: string; vector: Float32Array } | null>(null);
  const queryTaskRef = useRef<{ query: string; promise: Promise<Float32Array> } | null>(null);
  const memosRef = useRef(memos);
  memosRef.current = memos;

  // Activation: model → persisted index → first reconcile. Disabling (or a
  // re-enable) bumps the generation, which parks any in-flight loop.
  useEffect(() => {
    if (!enabled) {
      generationRef.current += 1;
      embedRef.current = null;
      queryVectorRef.current = null;
      queryTaskRef.current = null;
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
      const persistedIndex =
        !indexRef.current || indexRef.current.modelVersion !== MODEL_MANIFEST.version
          ? loadSemanticIndex(MODEL_MANIFEST.version)
          : Promise.resolve(indexRef.current);
      try {
        const [embed, loadedIndex] = await Promise.all([getEmbedder(), persistedIndex]);
        embedRef.current = embed;
        indexRef.current = loadedIndex ?? emptySemanticIndex(MODEL_MANIFEST.version);
      } catch {
        if (alive()) setStatus("error");
        return;
      }
      if (!alive()) return;
      setStatus("indexing");
      const embed = embedRef.current;
      const reconciled = await reconcileSemanticIndex(indexRef.current, memosRef.current, embed, {
        onProgress: (done, total) => {
          if (alive()) setProgress(total > 0 ? { done, total } : null);
        },
        onPartial: (partial) => {
          if (!alive()) return;
          indexRef.current = partial;
          setIndexEpoch((epoch) => epoch + 1);
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

  // Query → ranked results, debounced past keystrokes. During the first build,
  // a serialized query inference can take the next ONNX slot; its vector is
  // then reused as each partial index arrives instead of being recomputed.
  useEffect(() => {
    if (!enabled || (status !== "ready" && status !== "indexing")) {
      setResults(null);
      return;
    }
    const trimmed = query.trim();
    if (!trimmed) {
      setResults(null);
      return;
    }
    const index = indexRef.current;
    if (!index || index.rows.length === 0) {
      setResults(null);
      return;
    }
    const cached = queryVectorRef.current;
    if (cached?.query === trimmed) {
      setResults(searchSemanticIndex(index, cached.vector));
      return;
    }
    // A changed query must immediately fall back to keyword results rather
    // than showing semantic scores calculated for the previous text.
    setResults(null);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const embed = embedRef.current;
      if (!embed) return;
      void (async () => {
        let task = queryTaskRef.current;
        try {
          if (!task || task.query !== trimmed) {
            const promise = embed([RETRIEVAL_QUERY_PREFIX + trimmed]).then(([vector]) => vector);
            task = { query: trimmed, promise };
            queryTaskRef.current = task;
          }
          const vector = await task.promise;
          if (queryRef.current.trim() === trimmed) queryVectorRef.current = { query: trimmed, vector };
          const currentIndex = indexRef.current;
          if (!cancelled && currentIndex) setResults(searchSemanticIndex(currentIndex, vector));
        } catch {
          if (task && queryTaskRef.current === task) queryTaskRef.current = null;
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
