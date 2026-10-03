// Orchestrates semantic search for the feed: keeps the sealed vector index
// reconciled with the live memos and turns the (debounced) query into a
// ranked id → score map. The first build exposes consistent partial indexes
// at bounded checkpoints, so the feed can add semantic matches progressively
// without recopying the full vector corpus after every batch. Ordinary
// keyword search remains available throughout.
//
// Switching the feature on is not the same as starting the model. Activation
// only confirms the files are here and opens the sealed index; the ~123 MB
// runtime starts the first time something actually needs a vector — a query
// being typed, or memos whose text the index does not cover yet. A launch
// with nothing new to index and no search never loads it.
//
// Across tabs, one holds the indexer lock: only it embeds memos and writes the
// index, and it tells the others over a BroadcastChannel when there is a new
// index to read. The others still embed their own queries. Only a visible,
// healthy tab holds the lock: a hidden one (which iOS may suspend) or one stuck
// in an error lets go once its pass is over — sooner if another tab is waiting
// — so indexing follows the tab the user is looking at.
//
// Everything heavy happens off the render path. The hook publishes small
// state transitions; the per-batch and per-slice counters live in an external
// store (`live`) that only the surface showing them subscribes to.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { storedModelState } from "../lib/modelLoader";
import { MODEL_MANIFEST } from "../lib/modelManifest";
import { getEmbedder, RETRIEVAL_QUERY_PREFIX, runModelSelfTest, type EmbedFn } from "../lib/modelRuntime";
import {
  emptySemanticIndex,
  captureSemanticIndexWriteToken,
  deleteSemanticIndexDb,
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
  /** True while a query is being embedded or ranked; flips only at the edges. */
  queryBusy: boolean;
  /** Live indexing and query counters, for the surface that shows them. */
  live: SemanticProgressSource;
  /**
   * Ranked id → score for the current query; null while semantic ranking is
   * inactive or has no searchable rows yet. The feed always keeps keyword
   * matching active and merges this map when it is available.
   */
  results: ReadonlyMap<string, number> | null;
  /** Actionable detail for activation, indexing, or query failures. */
  error: string | null;
  /** Memos with at least one vector row in the live index. */
  indexedMemos: number;
  /** True from a rebuild request until that pass settles, so the panel can
      name the work honestly instead of calling it an ordinary first build. */
  rebuilding: boolean;
  /** Retry activation without requiring an off/on toggle. */
  retry: () => void;
  /** Discard the sealed index and embed every memo again from scratch. */
  rebuild: () => void;
}

export interface SemanticQueryProgress {
  stage: "waiting" | "embedding" | "ranking";
  done: number;
  total: number;
}

export interface SemanticProgressSnapshot {
  /** Memos embedded vs. memos pending, while indexing. */
  progress: SemanticIndexProgress | null;
  /** Observable stages for the current query and scoped vector ranking. */
  queryProgress: SemanticQueryProgress | null;
}

export interface SemanticProgressSource {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => SemanticProgressSnapshot;
}

const EMPTY_PROGRESS: SemanticProgressSnapshot = Object.freeze({ progress: null, queryProgress: null });

function createProgressSource(): SemanticProgressSource & { set: (patch: Partial<SemanticProgressSnapshot>) => void } {
  let snapshot = EMPTY_PROGRESS;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    set(patch) {
      const next = { ...snapshot, ...patch };
      if (next.progress === snapshot.progress && next.queryProgress === snapshot.queryProgress) return;
      snapshot = next;
      for (const listener of listeners) listener();
    }
  };
}

const noSubscribe = () => () => {};
const noSnapshot = () => null;

/** Subscribe to a hook's live counters; null without a source. */
export function useSemanticProgress(source: SemanticProgressSource | null | undefined): SemanticProgressSnapshot | null {
  return useSyncExternalStore(source?.subscribe ?? noSubscribe, source?.getSnapshot ?? noSnapshot, source?.getSnapshot ?? noSnapshot);
}

const QUERY_DEBOUNCE_MS = 250;
const RECONCILE_DEBOUNCE_MS = 1500;
/** Recent query vectors kept, so editing back to an earlier query re-ranks
    without another inference. 16 × 1.5 KB. */
const QUERY_VECTOR_CACHE_SIZE = 16;
const INDEXER_LOCK = "memo-semantic-indexer";
const INDEX_CHANNEL = "memo-semantic-index";

/** What the indexer tab tells the others, and the one thing they ask of it. */
type IndexMessage =
  | { type: "indexing"; rebuilding: boolean }
  | { type: "progress"; progress: SemanticIndexProgress | null }
  /** A checkpoint was written: there is a newer index to read. */
  | { type: "written" }
  /** The pass is over; `wrote` says whether its result was written. */
  | { type: "settled"; wrote: boolean }
  | { type: "rebuild" };

function semanticErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause || "Unknown semantic search error");
}

export function useSemanticSearch(
  enabled: boolean,
  memos: readonly Memo[],
  query: string,
  allowedMemoIds: ReadonlySet<string> | null = null,
  /**
   * How a finished ranking reaches the feed. A landing reorders every visible
   * row at once, so the caller gets to commit it inside whatever motion it
   * wants; the default just applies it. Only the landing goes through here —
   * dropping stale results (below) happens on the typing path, where a
   * per-keystroke transition would be worse than the cut it replaces.
   */
  publish: (commit: () => void) => void = (commit) => commit()
): SemanticSearchState {
  const [status, setStatus] = useState<SemanticSearchStatus>("off");
  const [live] = useState(createProgressSource);
  const [queryBusy, setQueryBusy] = useState(false);
  const [results, setResults] = useState<ReadonlyMap<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const [rebuilding, setRebuilding] = useState(false);
  /** Bumped whenever index content changes, so the search effect re-ranks. */
  const [indexEpoch, setIndexEpoch] = useState(0);
  /** This tab holds the indexer lock (always true without Web Locks). */
  const [leader, setLeader] = useState(false);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  /** Bumped when a pass ends that a debounced pass had to wait for. */
  const [rerunEpoch, setRerunEpoch] = useState(0);

  const statusRef = useRef(status);
  statusRef.current = status;
  // Written where leadership changes, not during render: activation reads it
  // across awaits that can land before the re-render that commits it.
  const leaderRef = useRef(false);
  const becomeLeader = useCallback((next: boolean) => {
    leaderRef.current = next;
    setLeader(next);
  }, []);
  /** Indexing passes this tab is running right now. */
  const passesRef = useRef(0);
  /** A debounced pass came due while another was still running. */
  const rerunRef = useRef(false);
  /** Lets go of this tab's indexer lock, held or still queued; null without one. */
  const lockRef = useRef<(() => void) | null>(null);
  /** The lock was given up while a pass was running: let go when it ends. */
  const releaseAfterPassRef = useRef(false);
  /** …and another tab is waiting for it, so that pass stops at its next batch. */
  const yieldPassRef = useRef(false);
  /** Another tab may have written the store since this one last read or wrote it. */
  const storeChangedRef = useRef(false);
  const embedderRef = useRef<Promise<EmbedFn> | null>(null);
  const indexRef = useRef<SemanticIndex | null>(null);
  const generationRef = useRef(0);
  const queryRef = useRef(query);
  queryRef.current = query;
  const queryVectorsRef = useRef(new Map<string, Float32Array>());
  const queryTaskRef = useRef<{ query: string; promise: Promise<Float32Array> } | null>(null);
  /** The query the published results were ranked for. */
  const resultsQueryRef = useRef<string | null>(null);
  const searchGenerationRef = useRef(0);
  const queryBusyRef = useRef(false);
  const memosRef = useRef(memos);
  memosRef.current = memos;
  const publishRef = useRef(publish);
  publishRef.current = publish;
  const channelRef = useRef<BroadcastChannel | null>(null);
  /** Consumed by the activation pass below: wipe the store before rebuilding. */
  const purgeRef = useRef(false);

  const setProgress = useCallback((progress: SemanticIndexProgress | null) => live.set({ progress }), [live]);
  const setQueryProgress = useCallback(
    (queryProgress: SemanticQueryProgress | null) => {
      live.set({ queryProgress });
      const busy = queryProgress !== null;
      if (queryBusyRef.current === busy) return;
      queryBusyRef.current = busy;
      setQueryBusy(busy);
    },
    [live]
  );
  const post = useCallback((message: IndexMessage) => {
    try {
      channelRef.current?.postMessage(message);
    } catch {
      // A closed channel only means no other tab is listening.
    }
  }, []);

  /** The runtime, started on first use: getEmbedder() plus its self-test. A
      failure stays put until retry, so one broken start is not repeated by
      every keystroke and batch that follows it. */
  const ensureEmbedder = useCallback((): Promise<EmbedFn> => {
    embedderRef.current ??= getEmbedder().then(async (embed) => {
      await runModelSelfTest();
      return embed;
    });
    return embedderRef.current;
  }, []);
  const lazyEmbed = useCallback<EmbedFn>((texts) => ensureEmbedder().then((embed) => embed(texts)), [ensureEmbedder]);

  const releaseLock = useCallback(() => {
    releaseAfterPassRef.current = false;
    yieldPassRef.current = false;
    const letGo = lockRef.current;
    lockRef.current = null;
    letGo?.();
  }, []);
  /** While a pass keeps a lock this tab is giving up: if another tab is
      queued for it, cut the pass short rather than make that tab wait. */
  const checkForWaiters = useCallback(() => {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    if (!releaseAfterPassRef.current || yieldPassRef.current || typeof locks?.query !== "function") return;
    void locks.query().then(
      (snapshot) => {
        if (releaseAfterPassRef.current && snapshot.pending?.some((lock) => lock.name === INDEXER_LOCK)) {
          yieldPassRef.current = true;
        }
      },
      () => {}
    );
  }, []);

  const retry = useCallback(() => setRetryEpoch((epoch) => epoch + 1), []);
  // A rebuild is activation with the stored vectors thrown away first: drop
  // the in-memory index here so the pass reloads (nothing) from the emptied
  // store, and route it through the same epoch the retry uses. Only the
  // indexer tab rebuilds; any other tab asks it to.
  const rebuild = useCallback(() => {
    if (!leaderRef.current) {
      post({ type: "rebuild" });
      return;
    }
    purgeRef.current = true;
    indexRef.current = null;
    queryVectorsRef.current.clear();
    queryTaskRef.current = null;
    setRebuilding(true);
    setRetryEpoch((epoch) => epoch + 1);
  }, [post]);
  const rebuildRef = useRef(rebuild);
  rebuildRef.current = rebuild;

  /**
   * One indexing pass from `start`, in the indexer tab. Only a pass with text
   * to embed is announced as indexing; dropping deleted memos or refreshing
   * timestamps needs no model and finishes quietly.
   */
  const runPass = useCallback(
    async (start: SemanticIndex, alive: () => boolean, embeds: boolean, rebuildingPass: boolean) => {
      const writeToken = captureSemanticIndexWriteToken();
      passesRef.current += 1;
      if (embeds) {
        setStatus("indexing");
        post({ type: "indexing", rebuilding: rebuildingPass });
      }
      let wrote = false;
      try {
        const reconciled = await reconcileSemanticIndex(start, memosRef.current, lazyEmbed, {
          onProgress: (nextProgress) => {
            checkForWaiters();
            if (!alive()) return;
            const progress = nextProgress.total > 0 ? nextProgress : null;
            setProgress(progress);
            if (embeds) post({ type: "progress", progress });
          },
          onPartial: (partial) => {
            if (!alive()) return;
            indexRef.current = partial;
            setIndexEpoch((epoch) => epoch + 1);
          },
          // Handing the lock to a waiting tab ends the pass like a finished
          // one: what it embedded so far is saved and announced.
          shouldContinue: () => alive() && !yieldPassRef.current,
          onFlush: async (partial) => {
            if (!alive()) return;
            indexRef.current = partial;
            await saveSemanticIndex(partial, writeToken);
            wrote = true;
            storeChangedRef.current = false;
            post({ type: "written" });
          }
        });
        if (!alive()) return;
        indexRef.current = reconciled;
        if (reconciled !== start) {
          await saveSemanticIndex(reconciled, writeToken);
          wrote = true;
          storeChangedRef.current = false;
        }
        post({ type: "settled", wrote });
        if (!alive()) return;
        setProgress(null);
        setIndexEpoch((epoch) => epoch + 1);
        setError(null);
        setStatus("ready");
        setRebuilding(false);
      } catch (cause) {
        post({ type: "settled", wrote });
        if (alive()) {
          setProgress(null);
          setError(semanticErrorMessage(cause));
          setStatus("error");
          setRebuilding(false);
        }
      } finally {
        passesRef.current -= 1;
        if (passesRef.current === 0) {
          if (releaseAfterPassRef.current) releaseLock();
          if (rerunRef.current) {
            rerunRef.current = false;
            setRerunEpoch((epoch) => epoch + 1);
          }
        }
      }
    },
    [checkForWaiters, lazyEmbed, post, releaseLock, setProgress]
  );

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const onVisibility = () => setVisible(document.visibilityState !== "hidden");
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [enabled]);

  // The indexer lock: wanted while enabled, visible, and able to index, and
  // queued behind another tab's. Giving it up waits for a running pass, so two
  // tabs never write at once.
  // (Without Web Locks every tab indexes for itself, whatever its state.)
  const webLocks = typeof navigator !== "undefined" && typeof navigator.locks?.request === "function";
  const lockWanted = !webLocks || (visible && status !== "error" && status !== "model-missing");
  useEffect(() => {
    if (!enabled) return;
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    if (typeof locks?.request !== "function") {
      becomeLeader(true);
      return () => becomeLeader(false);
    }
    if (!lockWanted) return;
    if (lockRef.current) {
      // Still held from before: the pass that kept it is running. Keep it.
      releaseAfterPassRef.current = false;
      yieldPassRef.current = false;
    } else {
      const abort = new AbortController();
      let active = true;
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      locks
        .request(INDEXER_LOCK, { signal: abort.signal }, async () => {
          if (!active) return;
          // Another tab indexed (or rebuilt) while this one waited: plan from
          // what it wrote, not from the copy this tab last read. Nothing to
          // read is an empty index, as at activation.
          if (storeChangedRef.current && indexRef.current) {
            const loaded = await loadSemanticIndex(MODEL_MANIFEST.version).catch(() => null);
            if (!active) return;
            if (indexRef.current) {
              indexRef.current = loaded ?? emptySemanticIndex(MODEL_MANIFEST.version);
              setIndexEpoch((epoch) => epoch + 1);
            }
            storeChangedRef.current = false;
          }
          becomeLeader(true);
          return held;
        })
        .catch(() => {});
      lockRef.current = () => {
        active = false;
        abort.abort();
        release();
        becomeLeader(false);
      };
    }
    return () => {
      if (passesRef.current > 0) {
        releaseAfterPassRef.current = true;
        checkForWaiters();
      } else {
        releaseLock();
      }
    };
  }, [enabled, lockWanted, becomeLeader, checkForWaiters, releaseLock]);

  // Taking over from a tab that went away mid-pass: that pass is not coming
  // back to settle, so this tab stops mirroring it and picks the work up.
  useEffect(() => {
    if (!leader || statusRef.current !== "indexing" || passesRef.current > 0) return;
    setProgress(null);
    setRebuilding(false);
    setStatus("ready");
  }, [leader, setProgress]);

  // The other tabs' side of the conversation.
  useEffect(() => {
    if (!enabled || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(INDEX_CHANNEL);
    channelRef.current = channel;
    let closed = false;
    let reloads = 0;
    let settledPending = false;
    const reload = () => {
      const reloadSerial = (reloads += 1);
      void loadSemanticIndex(MODEL_MANIFEST.version).then((loaded) => {
        if (closed || reloadSerial !== reloads || leaderRef.current) return;
        if (loaded) {
          indexRef.current = loaded;
          setIndexEpoch((epoch) => epoch + 1);
        }
        if (settledPending && statusRef.current === "indexing") {
          settledPending = false;
          setProgress(null);
          setRebuilding(false);
          setStatus("ready");
        }
      });
    };
    channel.onmessage = (event: MessageEvent<IndexMessage>) => {
      const message = event.data;
      if (leaderRef.current) {
        if (message?.type === "rebuild") rebuildRef.current();
        return;
      }
      if (message?.type === "indexing" || message?.type === "written" || (message?.type === "settled" && message.wrote)) {
        storeChangedRef.current = true;
      }
      const mirroring = statusRef.current === "ready" || statusRef.current === "indexing";
      if (!mirroring) return;
      switch (message?.type) {
        case "indexing":
          settledPending = false;
          setRebuilding(message.rebuilding);
          setStatus("indexing");
          break;
        case "progress":
          setProgress(message.progress);
          if (message.progress && statusRef.current === "ready") setStatus("indexing");
          break;
        case "written":
          reload();
          break;
        case "settled":
          settledPending = true;
          if (message.wrote) reload();
          else {
            settledPending = false;
            setProgress(null);
            setRebuilding(false);
            if (statusRef.current === "indexing") setStatus("ready");
          }
          break;
      }
    };
    return () => {
      closed = true;
      channel.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [enabled, retryEpoch, setProgress]);

  // Activation: files present → sealed index open. No model yet: that waits
  // for the first query or for memos that actually need embedding. Disabling
  // (or a re-enable) bumps the generation, which parks any in-flight loop.
  useEffect(() => {
    if (!enabled) {
      generationRef.current += 1;
      embedderRef.current = null;
      indexRef.current = null;
      queryVectorsRef.current.clear();
      queryTaskRef.current = null;
      purgeRef.current = false;
      setStatus("off");
      setProgress(null);
      setQueryProgress(null);
      setResults(null);
      setError(null);
      setRebuilding(false);
      return;
    }
    const generation = (generationRef.current += 1);
    const alive = () => generationRef.current === generation;
    const purge = purgeRef.current;
    purgeRef.current = false;
    // A retry starts the runtime afresh rather than replaying the failure.
    embedderRef.current = null;
    void (async () => {
      setError(null);
      setStatus("preparing");
      if (purge) {
        // Deleting the store also invalidates every write token handed out
        // before it, so an older pass still unwinding cannot write the
        // vectors we are discarding back into IndexedDB.
        setResults(null);
        setProgress(null);
        indexRef.current = null;
        await deleteSemanticIndexDb();
        if (!alive()) return;
      }
      if ((await storedModelState()) !== "complete") {
        if (alive()) {
          setStatus("model-missing");
          setRebuilding(false);
        }
        return;
      }
      const persisted =
        !indexRef.current || indexRef.current.modelVersion !== MODEL_MANIFEST.version
          ? await loadSemanticIndex(MODEL_MANIFEST.version)
          : indexRef.current;
      if (!alive()) return;
      const index = persisted ?? emptySemanticIndex(MODEL_MANIFEST.version);
      indexRef.current = index;
      setIndexEpoch((epoch) => epoch + 1);
      // A first build or a rebuild was asked for just now: start it. Anything
      // else — catching up on memos synced since the last visit — waits for
      // the debounced pass below, behind whatever the launch is doing.
      if (leaderRef.current && (purge || index.rows.length === 0)) {
        const embeds = planSemanticIndex(index, memosRef.current).stale.length > 0;
        await runPass(index, alive, embeds, purge);
        return;
      }
      setStatus("ready");
      setRebuilding(false);
    })().catch((cause: unknown) => {
      if (alive()) {
        setError(semanticErrorMessage(cause));
        setStatus("error");
        setRebuilding(false);
      }
    });
  }, [enabled, retryEpoch, runPass, setProgress, setQueryProgress]);

  // Later syncs and edits: fold changes in quietly once the dust settles.
  useEffect(() => {
    if (!enabled || status !== "ready" || !leader) return;
    const generation = generationRef.current;
    const alive = () => generationRef.current === generation;
    const timer = window.setTimeout(() => {
      const index = indexRef.current;
      if (!index) return;
      // A pass that needs no model leaves the status at ready, so this can
      // come due while one is still saving. Starting another from the same
      // index would let whichever finishes last drop the other's changes.
      if (passesRef.current > 0) {
        rerunRef.current = true;
        return;
      }
      const plan = planSemanticIndex(index, memosRef.current);
      if (plan.stale.length === 0 && plan.keptRowIndices.length === index.rows.length && plan.refreshedUpdatedAt.length === 0) return;
      void runPass(index, alive, plan.stale.length > 0, false);
      // An empty index is a first build still owed (this tab only just took
      // the lock, or the last one closed before a checkpoint): no reason to wait.
    }, indexRef.current?.rows.length === 0 ? 0 : RECONCILE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, status, memos, leader, rerunEpoch, runPass]);

  // Query → ranked results, debounced past keystrokes. During the first build,
  // a serialized query inference can take the next ONNX slot; its vector is
  // then reused as each partial index arrives instead of being recomputed.
  useEffect(() => {
    const searchGeneration = (searchGenerationRef.current += 1);
    const current = () => searchGenerationRef.current === searchGeneration;
    const clear = () => {
      setQueryProgress(null);
      resultsQueryRef.current = null;
      setResults(null);
    };
    if (!enabled || (status !== "ready" && status !== "indexing")) {
      clear();
      return;
    }
    const trimmed = query.trim();
    if (!trimmed) {
      clear();
      return;
    }
    const index = indexRef.current;
    if (!index || index.rows.length === 0) {
      clear();
      return;
    }
    const vectors = queryVectorsRef.current;
    const cached = vectors.get(trimmed);
    // A changed query must immediately fall back to keyword results rather
    // than showing semantic scores calculated for the previous text.
    if (resultsQueryRef.current !== trimmed) {
      resultsQueryRef.current = null;
      setResults(null);
    }
    setQueryProgress({ stage: cached ? "ranking" : "waiting", done: 0, total: index.rows.length });
    // Typing is the intent: start the runtime now rather than after the
    // debounce, so a cold first query waits less.
    if (!cached) void ensureEmbedder().catch(() => {});

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
      if (current()) {
        publishRef.current(() => {
          resultsQueryRef.current = trimmed;
          setResults(ranked);
        });
      }
    };

    const fail = (cause: unknown) => {
      if (!current()) return;
      resultsQueryRef.current = null;
      setResults(null);
      setError(semanticErrorMessage(cause));
      setStatus("error");
    };

    let timer = 0;
    const run = async () => {
      let task = queryTaskRef.current;
      try {
        if (current()) setQueryProgress({ stage: "embedding", done: 0, total: 1 });
        if (!task || task.query !== trimmed) {
          const promise = lazyEmbed([RETRIEVAL_QUERY_PREFIX + trimmed]).then(([vector]) => vector);
          task = { query: trimmed, promise };
          queryTaskRef.current = task;
        }
        const vector = await task.promise;
        if (queryRef.current.trim() === trimmed) {
          vectors.delete(trimmed);
          vectors.set(trimmed, vector);
          if (vectors.size > QUERY_VECTOR_CACHE_SIZE) vectors.delete(vectors.keys().next().value!);
        }
        await rank(vector);
      } catch (cause) {
        if (task && queryTaskRef.current === task) queryTaskRef.current = null;
        fail(cause);
      } finally {
        if (current()) setQueryProgress(null);
      }
    };

    if (cached) {
      // Most recently used last: the oldest query is the first to go.
      vectors.delete(trimmed);
      vectors.set(trimmed, cached);
      void rank(cached)
        .catch(fail)
        .finally(() => current() && setQueryProgress(null));
    } else {
      timer = window.setTimeout(() => void run(), QUERY_DEBOUNCE_MS);
    }
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [enabled, status, query, indexEpoch, allowedMemoIds, ensureEmbedder, lazyEmbed, setQueryProgress]);

  // The index lives in a ref because it changes far more often than it is
  // rendered; indexEpoch is its render signal, so the headline figure the
  // settings panel shows follows exactly the same beat as the search results.
  const indexedMemos = useMemo(() => {
    const index = status === "off" ? null : indexRef.current;
    if (!index) return 0;
    const memoIds = new Set<string>();
    for (const row of index.rows) memoIds.add(row.id);
    return memoIds.size;
  }, [indexEpoch, status]);

  return { status, queryBusy, live, results, error, indexedMemos, rebuilding, retry, rebuild };
}
