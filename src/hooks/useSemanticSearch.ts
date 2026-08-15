// Orchestrates semantic search for the feed: activates the on-device model,
// keeps the sealed vector index reconciled with the live memos, and turns
// the (debounced) query into a ranked id → score map. The first build exposes
// consistent partial indexes at bounded checkpoints, so the feed can add
// semantic matches progressively without recopying the full vector corpus
// after every batch. Ordinary keyword search remains available throughout.
// Everything heavy — model activation, embedding, ranking — happens off the
// render path; the hook only ever publishes small state transitions.

import { useCallback, useEffect, useRef, useState } from "react";
import { storedModelState } from "../lib/modelLoader";
import { MODEL_MANIFEST } from "../lib/modelManifest";
import { getEmbedder, RETRIEVAL_QUERY_PREFIX, runModelSelfTest, type EmbedFn } from "../lib/modelRuntime";
import {
  emptySemanticIndex,
  captureSemanticIndexWriteToken,
  loadSemanticIndex,
  planSemanticIndex,
  reconcileSemanticIndex,
  saveSemanticIndex,
  searchSemanticIndexAsync,
  type SemanticIndex,
  type SemanticIndexProgress
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
  progress: SemanticIndexProgress | null;
  /** Observable stages for the current query and scoped vector ranking. */
  queryProgress: SemanticQueryProgress | null;
  /**
   * Ranked id → score for the current query; null while semantic ranking is
   * inactive or has no searchable rows yet. The feed always keeps keyword
   * matching active and merges this map when it is available.
   */
  results: ReadonlyMap<string, number> | null;
  /** Actionable detail for activation, indexing, or query failures. */
  error: string | null;
  /** Retry activation without requiring an off/on toggle. */
  retry: () => void;
}

export interface SemanticQueryProgress {
  stage: "waiting" | "embedding" | "ranking";
  done: number;
  total: number;
}

const QUERY_DEBOUNCE_MS = 250;
const RECONCILE_DEBOUNCE_MS = 1500;

function semanticErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause || "Unknown semantic search error");
}

export function useSemanticSearch(
  enabled: boolean,
  memos: readonly Memo[],
  query: string,
  allowedMemoIds: ReadonlySet<string> | null = null
): SemanticSearchState {
  const [status, setStatus] = useState<SemanticSearchStatus>("off");
  const [progress, setProgress] = useState<SemanticIndexProgress | null>(null);
  const [queryProgress, setQueryProgress] = useState<SemanticQueryProgress | null>(null);
  const [results, setResults] = useState<ReadonlyMap<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryEpoch, setRetryEpoch] = useState(0);
  /** Bumped whenever index content changes, so the search effect re-ranks. */
  const [indexEpoch, setIndexEpoch] = useState(0);

  const embedRef = useRef<EmbedFn | null>(null);
  const indexRef = useRef<SemanticIndex | null>(null);
  const generationRef = useRef(0);
  const queryRef = useRef(query);
  queryRef.current = query;
  const queryVectorRef = useRef<{ query: string; vector: Float32Array } | null>(null);
  const queryTaskRef = useRef<{ query: string; promise: Promise<Float32Array> } | null>(null);
  const searchGenerationRef = useRef(0);
  const memosRef = useRef(memos);
  memosRef.current = memos;
  const retry = useCallback(() => setRetryEpoch((epoch) => epoch + 1), []);

  // Activation: model → persisted index → first reconcile. Disabling (or a
  // re-enable) bumps the generation, which parks any in-flight loop.
  useEffect(() => {
    if (!enabled) {
      generationRef.current += 1;
      embedRef.current = null;
      indexRef.current = null;
      queryVectorRef.current = null;
      queryTaskRef.current = null;
      setStatus("off");
      setProgress(null);
      setQueryProgress(null);
      setResults(null);
      setError(null);
      return;
    }
    const generation = (generationRef.current += 1);
    const alive = () => generationRef.current === generation;
    const writeToken = captureSemanticIndexWriteToken();
    void (async () => {
      setError(null);
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
        const [embed, loadedIndex] = await Promise.all([
          getEmbedder().then(async (readyEmbed) => {
            await runModelSelfTest();
            return readyEmbed;
          }),
          persistedIndex
        ]);
        embedRef.current = embed;
        indexRef.current = loadedIndex ?? emptySemanticIndex(MODEL_MANIFEST.version);
        if (!alive()) return;
        const startingIndex = indexRef.current;
        setStatus("indexing");
        const reconciled = await reconcileSemanticIndex(startingIndex, memosRef.current, embed, {
          onProgress: (nextProgress) => {
            if (alive()) setProgress(nextProgress.total > 0 ? nextProgress : null);
          },
          onPartial: (partial) => {
            if (!alive()) return;
            indexRef.current = partial;
            setIndexEpoch((epoch) => epoch + 1);
          },
          shouldContinue: alive,
          onFlush: (partial) => {
            if (!alive()) return;
            indexRef.current = partial;
            return saveSemanticIndex(partial, writeToken);
          }
        });
        if (!alive()) return;
        indexRef.current = reconciled;
        if (reconciled !== startingIndex) await saveSemanticIndex(reconciled, writeToken);
        if (!alive()) return;
        setProgress(null);
        setIndexEpoch((epoch) => epoch + 1);
        setError(null);
        setStatus("ready");
      } catch (cause) {
        if (alive()) {
          setProgress(null);
          setError(semanticErrorMessage(cause));
          setStatus("error");
        }
      }
    })();
  }, [enabled, retryEpoch]);

  // Later syncs and edits: fold changes in quietly once the dust settles.
  useEffect(() => {
    if (!enabled || status !== "ready") return;
    const generation = generationRef.current;
    const alive = () => generationRef.current === generation;
    const timer = window.setTimeout(() => {
      const embed = embedRef.current;
      const index = indexRef.current;
      if (!embed || !index) return;
      const plan = planSemanticIndex(index, memosRef.current);
      if (plan.stale.length === 0 && plan.keptRowIndices.length === index.rows.length && plan.refreshedUpdatedAt.length === 0) return;
      void (async () => {
        const writeToken = captureSemanticIndexWriteToken();
        setStatus("indexing");
        try {
          const reconciled = await reconcileSemanticIndex(index, memosRef.current, embed, {
            shouldContinue: alive,
            onProgress: (nextProgress) => {
              if (alive()) setProgress(nextProgress.total > 0 ? nextProgress : null);
            },
            onPartial: (partial) => {
              if (!alive()) return;
              indexRef.current = partial;
              setIndexEpoch((epoch) => epoch + 1);
            },
            onFlush: (partial) => {
              if (!alive()) return;
              indexRef.current = partial;
              return saveSemanticIndex(partial, writeToken);
            }
          });
          if (!alive()) return;
          indexRef.current = reconciled;
          if (reconciled !== index) await saveSemanticIndex(reconciled, writeToken);
          if (!alive()) return;
          setProgress(null);
          setIndexEpoch((epoch) => epoch + 1);
          setError(null);
          setStatus("ready");
        } catch (cause) {
          if (alive()) {
            setProgress(null);
            setError(semanticErrorMessage(cause));
            setStatus("error");
          }
        }
      })();
    }, RECONCILE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, status, memos]);

  // Query → ranked results, debounced past keystrokes. During the first build,
  // a serialized query inference can take the next ONNX slot; its vector is
  // then reused as each partial index arrives instead of being recomputed.
  useEffect(() => {
    const searchGeneration = (searchGenerationRef.current += 1);
    const current = () => searchGenerationRef.current === searchGeneration;
    if (!enabled || (status !== "ready" && status !== "indexing")) {
      setQueryProgress(null);
      setResults(null);
      return;
    }
    const trimmed = query.trim();
    if (!trimmed) {
      setQueryProgress(null);
      setResults(null);
      return;
    }
    const index = indexRef.current;
    if (!index || index.rows.length === 0) {
      setQueryProgress(null);
      setResults(null);
      return;
    }
    const cached = queryVectorRef.current;
    // A changed query must immediately fall back to keyword results rather
    // than showing semantic scores calculated for the previous text.
    if (cached?.query !== trimmed) setResults(null);
    setQueryProgress({ stage: cached?.query === trimmed ? "ranking" : "waiting", done: 0, total: index.rows.length });

    const rank = async (vector: Float32Array) => {
      const currentIndex = indexRef.current;
      if (!current() || !currentIndex) return;
      setQueryProgress({ stage: "ranking", done: 0, total: currentIndex.rows.length });
      const ranked = await searchSemanticIndexAsync(currentIndex, vector, allowedMemoIds, {
        shouldContinue: current,
        onProgress: (done, total) => {
          if (current()) setQueryProgress({ stage: "ranking", done, total });
        }
      });
      if (current()) setResults(ranked);
    };

    let timer = 0;
    const run = async () => {
      const embed = embedRef.current;
      if (!embed) {
        if (current()) setQueryProgress(null);
        return;
      }
      let task = queryTaskRef.current;
      try {
        if (current()) setQueryProgress({ stage: "embedding", done: 0, total: 1 });
        if (!task || task.query !== trimmed) {
          const promise = embed([RETRIEVAL_QUERY_PREFIX + trimmed]).then(([vector]) => vector);
          task = { query: trimmed, promise };
          queryTaskRef.current = task;
        }
        const vector = await task.promise;
        if (queryRef.current.trim() === trimmed) queryVectorRef.current = { query: trimmed, vector };
        await rank(vector);
      } catch (cause) {
        if (task && queryTaskRef.current === task) queryTaskRef.current = null;
        if (current()) {
          setResults(null);
          setError(semanticErrorMessage(cause));
          setStatus("error");
        }
      } finally {
        if (current()) setQueryProgress(null);
      }
    };

    if (cached?.query === trimmed) {
      void rank(cached.vector)
        .catch((cause: unknown) => {
          if (current()) {
            setResults(null);
            setError(semanticErrorMessage(cause));
            setStatus("error");
          }
        })
        .finally(() => current() && setQueryProgress(null));
    } else {
      timer = window.setTimeout(() => void run(), QUERY_DEBOUNCE_MS);
    }
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [enabled, status, query, indexEpoch, allowedMemoIds]);

  return { status, progress, queryProgress, results, error, retry };
}
