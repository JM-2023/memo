import { ChevronDown, Download, FileDown, HardDrive, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useModalA11y } from "../hooks/useModalA11y";
import { useReducedMotion } from "../hooks/useReducedMotion";
import type { SemanticQueryProgress, SemanticSearchStatus } from "../hooks/useSemanticSearch";
import { useI18n } from "../lib/i18n";
import {
  cancelModelDownload,
  classifyModelFailure,
  getModelDownloadSnapshot,
  isModelWorkInFlight,
  resetModelDownload,
  startModelDownload,
  useModelDownload,
  type ModelFailureCause
} from "../lib/modelDownload";
import { clearModelFiles, importModelFiles, presentModelFiles, readModelFileBytes, type MirrorFailure } from "../lib/modelLoader";
import { MODEL_MANIFEST, modelTotalBytes, type ModelFileSpec } from "../lib/modelManifest";
import { getModelRuntimeProgress, resetModelRuntime, subscribeModelRuntimeProgress } from "../lib/modelRuntime";
import { deleteSemanticIndexDb, EMBED_BATCH_TEXTS, type SemanticIndexProgress } from "../lib/semanticIndex";
import type { OrbState } from "../lib/thinkingOrb";
import { ThinkingOrb } from "./ThinkingOrb";

interface ModelSettingsModalProps {
  onClose: () => void;
  onModelCleared: () => void;
  /** Completes a Brain-toggle request that first had to download the model. */
  onModelReady?: () => void;
  onSemanticRetry?: () => void;
  /** Throws the sealed index away and embeds every memo again. Omitted when
      there is no live index to rebuild, which also hides the control. */
  onSemanticReindex?: () => void;
  semanticStatus?: SemanticSearchStatus;
  semanticProgress?: SemanticIndexProgress | null;
  semanticQueryProgress?: SemanticQueryProgress | null;
  semanticError?: string | null;
  /** Memos with vectors in the live index — the figure the rebuild acts on. */
  semanticIndexedMemos?: number;
  /** True while the current indexing pass is a rebuild, not a first build. */
  semanticRebuilding?: boolean;
  /** The live search text — quoted by the "Understanding query" meta line. */
  semanticQuery?: string;
  /**
   * Non-zero when the Brain button opened the panel to show unfinished work:
   * the progress block plays its attention wash and is scrolled into view.
   */
  attend?: number;
}

/** What only this panel instance knows: it is still reading the device, or
    it is clearing it. Downloading and activating belong to the app-level
    store (src/lib/modelDownload.ts), which outlives the panel. */
type Local =
  | { kind: "checking" }
  | { kind: "settled" }
  | { kind: "clearing" }
  | { kind: "clear-error"; message: string };

/** The panel's own view of the model, folded from the local phase, the
    download store and the files actually present on this device. */
type View =
  | { kind: "checking" }
  | { kind: "idle"; stored: "none" | "partial" }
  | { kind: "paused" }
  | { kind: "downloading" }
  | { kind: "activating" }
  | { kind: "clearing" }
  | { kind: "ready" }
  | { kind: "error"; origin: "download" | "activate" | "clear"; message: string; failures: readonly MirrorFailure[] };

/** The redesign's lifecycle vocabulary — one look per moment of the feature. */
type StateId =
  | "checking"
  | "idle"
  | "paused"
  | "downloading"
  | "loading"
  | "ready"
  | "indexing"
  | "rebuilding"
  | "searching"
  | "failed"
  | "clearing";

/** Which of the six thinking-orbs marks each state wears. Nothing is ever
    frozen: at rest the mark keeps moving, muted, rather than stopping. */
const ORB: Record<StateId, OrbState> = {
  checking: "working",
  idle: "shaping",
  // A pause is a rest, not a fault: the same mark as "not downloaded".
  paused: "shaping",
  downloading: "working",
  loading: "working",
  ready: "connecting",
  indexing: "solving",
  // Same work, same mark — only the words say it is starting over.
  rebuilding: "solving",
  searching: "searching",
  failed: "breathing",
  clearing: "working"
};

const TOTAL_BYTES = modelTotalBytes();

function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function fileSize(bytes: number): string {
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  return megabytes(bytes);
}

function failureHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

interface StageRow {
  name: string;
  note: string;
  tone: "done" | "active" | "idle";
}

/** The one live progress surface: a label, the figure, a bar, a meta line,
    and the expandable stage list beneath it. */
interface ProgressView {
  label: string;
  value: string;
  meta: string;
  percent: number;
  stages: StageRow[];
}

const EMPTY_PROGRESS: ProgressView = { label: "", value: "", meta: "", percent: 0, stages: [] };

/**
 * The Semantic Search panel, redesigned: a 640px surface split into the
 * present tense (left — the orb, one true progress bar, an expandable stage
 * list) and this device's facts (right). Downloading, verifying, activating,
 * importing and exporting the on-device embedding model all live here;
 * "Ready" is only shown after a real self-test inference on this device.
 * The download itself belongs to the app, not the panel: closing this
 * surface leaves it running, and reopening picks the live progress back up.
 */
export function ModelSettingsModal({
  onClose,
  onModelCleared,
  onModelReady,
  onSemanticRetry,
  onSemanticReindex,
  semanticStatus = "off",
  semanticProgress = null,
  semanticQueryProgress = null,
  semanticError = null,
  semanticIndexedMemos = 0,
  semanticRebuilding = false,
  semanticQuery = "",
  attend = 0
}: ModelSettingsModalProps) {
  const { tr, formatNumber } = useI18n();
  const reducedMotion = useReducedMotion();
  const runtimeProgress = useSyncExternalStore(
    subscribeModelRuntimeProgress,
    getModelRuntimeProgress,
    getModelRuntimeProgress
  );
  const download = useModelDownload();

  const [local, setLocal] = useState<Local>({ kind: "checking" });
  const [present, setPresent] = useState<ReadonlySet<string>>(() => new Set());
  const [importNote, setImportNote] = useState<string | null>(null);
  const [clearNote, setClearNote] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [confirmingRebuild, setConfirmingRebuild] = useState(false);
  const [closing, setClosing] = useState(false);
  const [stagesOpen, setStagesOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);

  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const progressBlockRef = useRef<HTMLDivElement>(null);
  const stagesRegionRef = useRef<HTMLDivElement>(null);
  const actionRegionRef = useRef<HTMLDivElement>(null);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const rebuildRegionRef = useRef<HTMLDivElement>(null);
  const rebuildConfirmRef = useRef<HTMLButtonElement>(null);
  const advRegionRef = useRef<HTMLDivElement>(null);
  const dismissTimer = useRef(0);
  const disposedRef = useRef(false);
  const readyReportedRef = useRef(false);
  const cancelledHereRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const modelReadyRef = useRef(onModelReady);
  modelReadyRef.current = onModelReady;

  const safeSetLocal = useCallback((next: Local) => {
    if (!disposedRef.current) setLocal(next);
  }, []);

  const refreshPresence = useCallback(async () => {
    const files = await presentModelFiles();
    if (!disposedRef.current) setPresent(files);
    return files;
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    void (async () => {
      const files = await refreshPresence();
      if (disposedRef.current) return;
      const complete = MODEL_MANIFEST.files.every((file) => files.has(file.requestPath));
      // Every file here: activate (a no-op when the runtime is already live,
      // and the same promise when a download is finishing right now). Files
      // gone while the store still says ready — a logout cleared them — and
      // the store's word is stale.
      if (complete) void startModelDownload();
      else if (getModelDownloadSnapshot().phase === "ready") resetModelDownload();
      setLocal({ kind: "settled" });
    })();
    return () => {
      disposedRef.current = true;
      window.clearTimeout(dismissTimer.current);
    };
  }, [refreshPresence]);

  /* The device column follows the store: once bytes stop moving — landed,
     paused, failed, reset — the key listing is the fact, and the bar's
     arithmetic was only ever a preview of it. */
  const downloadPhase = download.phase;
  useEffect(() => {
    if (downloadPhase === "downloading" || downloadPhase === "activating") return;
    void refreshPresence();
  }, [downloadPhase, refreshPresence]);

  useEffect(() => {
    if (downloadPhase !== "ready" || readyReportedRef.current) return;
    readyReportedRef.current = true;
    modelReadyRef.current?.();
  }, [downloadPhase]);

  const requestClose = useCallback(() => {
    if (closing) return;
    if (reducedMotion) {
      closeRef.current();
      return;
    }
    setClosing(true);
    dismissTimer.current = window.setTimeout(() => closeRef.current(), 170);
  }, [closing, reducedMotion]);

  const overlayRef = useModalA11y<HTMLDivElement>({ onEscape: requestClose, initialFocusRef: closeButtonRef });

  async function handleImport(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setImportNote(null);
    try {
      const result = await importModelFiles([...fileList]);
      const files = await refreshPresence();
      const gained = result.imported.length;
      const notes: string[] = [];
      if (gained > 0) notes.push(tr(`Imported ${gained} file${gained === 1 ? "" : "s"}.`, `已导入 ${gained} 个文件。`));
      if (result.unmatched.length > 0) {
        notes.push(
          tr(
            `Not part of this model, skipped: ${result.unmatched.join(", ")}.`,
            `以下文件与该模型不符，已跳过：${result.unmatched.join("、")}。`
          )
        );
      }
      if (!disposedRef.current) setImportNote(notes.join(" ") || null);
      const complete = MODEL_MANIFEST.files.every((file) => files.has(file.requestPath));
      if (complete) void startModelDownload();
    } catch {
      if (!disposedRef.current) setImportNote(tr("Couldn't read those files.", "无法读取所选文件。"));
    }
  }

  const clearModel = useCallback(async () => {
    setConfirmingClear(false);
    setImportNote(null);
    setClearNote(null);
    safeSetLocal({ kind: "clearing" });
    onModelCleared();
    try {
      await Promise.all([resetModelRuntime(), clearModelFiles(), deleteSemanticIndexDb()]);
      // The store's word about the model goes with the model — whether or
      // not this panel is still open to see it.
      resetModelDownload();
      if (disposedRef.current) return;
      setPresent(new Set());
      setClearNote(tr("Model and semantic index cleared from this device.", "已从此设备清除模型和语义索引。"));
      safeSetLocal({ kind: "settled" });
    } catch (cause) {
      safeSetLocal({ kind: "clear-error", message: cause instanceof Error ? cause.message : String(cause) });
    }
  }, [onModelCleared, safeSetLocal, tr]);

  async function handleExportFile(spec: ModelFileSpec) {
    const bytes = await readModelFileBytes(spec.requestPath);
    if (!bytes) return;
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = spec.asset;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ---- the lifecycle, in the redesign's vocabulary ---------------------- */

  const filesComplete = MODEL_MANIFEST.files.every((file) => present.has(file.requestPath));

  const view: View = (() => {
    if (local.kind === "checking") return { kind: "checking" };
    if (local.kind === "clearing") return { kind: "clearing" };
    if (local.kind === "clear-error") return { kind: "error", origin: "clear", message: local.message, failures: [] };
    switch (download.phase) {
      case "downloading":
        return { kind: "downloading" };
      case "activating":
        return { kind: "activating" };
      case "ready":
        return { kind: "ready" };
      case "cancelled":
        return { kind: "paused" };
      case "error":
        return {
          kind: "error",
          origin: download.error?.origin ?? "download",
          message: download.error?.message ?? "",
          failures: download.error?.failures ?? []
        };
      default:
        // Idle with every file present is the instant before activation
        // starts; anything else is a device waiting for its download.
        return filesComplete ? { kind: "checking" } : { kind: "idle", stored: present.size > 0 ? "partial" : "none" };
    }
  })();

  const stateId: StateId =
    view.kind === "checking"
      ? "checking"
      : view.kind === "idle"
        ? "idle"
        : view.kind === "paused"
          ? "paused"
          : view.kind === "downloading"
            ? "downloading"
            : view.kind === "activating"
              ? "loading"
              : view.kind === "clearing"
                ? "clearing"
                : view.kind === "error"
                  ? "failed"
                  : semanticStatus === "error"
                    ? "failed"
                    : // A rebuild owns both of its phases: the moment spent
                      // clearing the store is not the model loading again.
                      semanticRebuilding && (semanticStatus === "preparing" || semanticStatus === "indexing")
                      ? "rebuilding"
                      : semanticStatus === "preparing"
                        ? "loading"
                        : semanticStatus === "indexing"
                          ? "indexing"
                          : semanticQueryProgress
                            ? "searching"
                            : "ready";

  const busy = local.kind === "checking" || local.kind === "clearing" || isModelWorkInFlight(download);
  const idlePartial = view.kind === "idle" && view.stored === "partial";
  const errorOrigin = view.kind === "error" ? view.origin : semanticStatus === "error" ? "semantic" : null;
  /* The cause, sorted into the handful the panel has words for. The raw
     reason stays out of the headline; Advanced carries it as detail. */
  const failureCause: ModelFailureCause | null =
    view.kind === "error"
      ? view.origin === "clear"
        ? null
        : classifyModelFailure(view.origin, view.message, view.failures)
      : semanticStatus === "error"
        ? classifyModelFailure("semantic", semanticError ?? "")
        : null;
  const errorDetail: { message: string; failures: readonly MirrorFailure[] } | null =
    view.kind === "error"
      ? { message: view.message, failures: view.failures }
      : semanticStatus === "error" && semanticError
        ? { message: semanticError, failures: [] }
        : null;

  const wholeMb = (bytes: number) => formatNumber(Math.round(bytes / 1e6));
  const storedBytes = MODEL_MANIFEST.files.reduce((sum, file) => sum + (present.has(file.requestPath) ? file.bytes : 0), 0);
  // Right after a cancel the store already knows what was kept; the key
  // listing catches up a beat later.
  const keptBytes = view.kind === "paused" ? Math.max(storedBytes, download.loadedBytes) : storedBytes;
  const keptLine = tr(
    `${wholeMb(keptBytes)} of ${wholeMb(TOTAL_BYTES)} MB kept. Resume to finish the download.`,
    `已保留 ${wholeMb(keptBytes)} / ${wholeMb(TOTAL_BYTES)} MB，继续下载即可完成。`
  );

  /* "How long": from the store's smoothed rate, and only once it has one —
     a guess would be worse than the plain promise that search keeps working. */
  const etaLine = (() => {
    if (view.kind !== "downloading" || !download.bytesPerSecond) return "";
    const seconds = Math.max(0, download.totalBytes - download.loadedBytes) / download.bytesPerSecond;
    if (seconds < 45) return tr("Less than a minute left.", "不到 1 分钟。");
    if (seconds < 90) return tr("About a minute left.", "预计还需约 1 分钟。");
    const minutes = formatNumber(Math.ceil(seconds / 60));
    return tr(`About ${minutes} minutes left.`, `预计还需约 ${minutes} 分钟。`);
  })();

  const failureLine = (cause: ModelFailureCause): string => {
    switch (cause.kind) {
      case "offline":
        return tr("Couldn't reach the download server. Check your connection and try again.", "无法连接下载服务器，请检查网络后重试。");
      case "http":
        return tr(
          `The download server returned an error (${cause.status}). Try again later.`,
          `下载服务器返回错误（${cause.status}），请稍后重试。`
        );
      case "verify":
        return tr("A file didn't verify. Try the download again.", "有文件未通过校验，请重新下载。");
      case "storage":
        return errorOrigin === "semantic"
          ? tr("The index couldn't be saved. Not enough storage, or this is a private window.", "索引无法保存：存储空间不足，或当前是无痕窗口。")
          : tr("Not enough storage to keep the model, or this is a private window.", "存储空间不足以保留模型，或当前是无痕窗口。");
      case "activate":
        return tr("The model couldn't start on this device.", "模型无法在此设备上启动。");
      default:
        return errorOrigin === "semantic"
          ? tr("Semantic search ran into a problem. Retry to start it again.", "语义搜索遇到问题，请重试。")
          : tr("The download failed. Try again.", "下载失败，请重试。");
    }
  };

  const indexLine = (rebuilding: boolean): string => {
    const done = semanticProgress?.done ?? 0;
    const total = semanticProgress?.total ?? 0;
    if (total > 0) {
      return tr(
        `${formatNumber(done)} of ${formatNumber(total)} memos · keyword search keeps working.`,
        `已处理 ${formatNumber(done)} / ${formatNumber(total)} 条笔记 · 关键词搜索不受影响。`
      );
    }
    return rebuilding
      ? tr("Keyword search keeps working while the index rebuilds.", "重建索引期间，关键词搜索不受影响。")
      : tr("Keyword search keeps working while the index builds.", "建立索引期间，关键词搜索不受影响。");
  };

  const headline =
    stateId === "checking"
      ? tr("Checking device", "正在检查设备")
      : stateId === "idle"
        ? idlePartial
          ? tr("Download incomplete", "下载未完成")
          : tr("Model not downloaded", "模型尚未下载")
        : stateId === "paused"
          ? tr("Download paused", "已暂停下载")
          : stateId === "downloading"
            ? tr("Downloading the model", "正在下载模型")
            : stateId === "loading"
              ? tr("Starting up", "正在启动")
              : stateId === "ready"
                ? tr("Ready", "已就绪")
                : stateId === "indexing"
                  ? tr("Indexing your memos", "正在为笔记建立索引")
                  : stateId === "rebuilding"
                    ? tr("Rebuilding the index", "正在重建索引")
                    : stateId === "searching"
                      ? tr("Searching this view", "正在搜索当前范围")
                      : stateId === "clearing"
                        ? tr("Clearing model", "正在清除模型")
                        : errorOrigin === "semantic"
                          ? tr("Semantic search stopped", "语义搜索已停止")
                          : errorOrigin === "activate"
                            ? tr("Model couldn't start", "模型启动失败")
                            : errorOrigin === "clear"
                              ? tr("Couldn't clear the model", "无法清除模型")
                              : tr("Download failed", "下载失败");

  /* The second line answers "what can I do now, and how long": the work
     that is on, what it costs, and what keeps working meanwhile. */
  const subline =
    stateId === "checking"
      ? tr("Looking for model files already on this device.", "正在查找此设备上已有的模型文件。")
      : stateId === "idle"
        ? idlePartial
          ? keptLine
          : tr("Download the model once to search your memos by meaning.", "下载一次模型，即可按意思搜索笔记。")
        : stateId === "paused"
          ? keptLine
          : stateId === "downloading"
            ? tr(`Keyword search keeps working.${etaLine ? ` ${etaLine}` : ""}`, `关键词搜索不受影响。${etaLine}`)
            : stateId === "loading"
              ? tr("Almost ready.", "马上就好。")
              : stateId === "ready"
                ? tr("Verified on this device and available offline.", "已在此设备上验证，可离线使用。")
                : stateId === "indexing"
                  ? indexLine(false)
                  : stateId === "rebuilding"
                    ? indexLine(true)
                    : stateId === "searching"
                      ? tr("Ranking only the memos inside the current view.", "仅对当前范围内的笔记排序。")
                      : stateId === "clearing"
                        ? tr("Removing the model files and the semantic index.", "正在删除模型文件和语义索引。")
                        : errorOrigin === "clear"
                          ? tr("The model couldn't be cleared. Try again.", "无法清除模型，请重试。")
                          : failureCause
                            ? failureLine(failureCause)
                            : "";

  /* One true progress surface per working state, every figure real. */
  const progress: ProgressView = (() => {
    const row = (name: string, note: string, tone: StageRow["tone"]): StageRow => ({ name, note, tone });

    if (stateId === "downloading") {
      const loaded = download.loadedBytes;
      const total = download.totalBytes || TOTAL_BYTES;
      const pct = Math.min(100, Math.floor((loaded / total) * 100));
      let sum = 0;
      const stages = MODEL_MANIFEST.files.map((file) => {
        const start = sum;
        sum += file.bytes;
        if (loaded >= sum) return row(file.asset, tr("Verified", "已验证"), "done");
        if (loaded > start) return row(file.asset, `${Math.floor(((loaded - start) / file.bytes) * 100)}%`, "active");
        return row(file.asset, tr("Waiting", "等待中"), "idle");
      });
      return {
        label: tr("Download", "下载"),
        value: `${pct}%`,
        meta: tr(
          `${megabytes(loaded)} of ${megabytes(total)} · ${download.filesDone} of ${download.filesTotal} files`,
          `${megabytes(loaded)} / ${megabytes(total)} · ${download.filesDone} / ${download.filesTotal} 个文件`
        ),
        percent: pct,
        stages
      };
    }

    if (stateId === "loading") {
      /* The four runtime steps modelRuntime.ts actually publishes, in order. */
      const steps = [
        tr("Loading the private search engine", "加载本地搜索引擎"),
        tr("Reading verified files from storage", "从存储读取已验证文件"),
        tr("Starting the inference worker", "启动推理 Worker"),
        tr("Checking results with a real inference", "通过真实推理检查结果")
      ];
      const step =
        runtimeProgress.stage === "loading-files"
          ? 1
          : runtimeProgress.stage === "starting-runtime" || runtimeProgress.stage === "runtime-ready"
            ? 2
            : runtimeProgress.stage === "self-testing"
              ? 3
              : runtimeProgress.stage === "ready"
                ? 4
                : 0;
      return {
        label: tr("Model loading", "模型加载"),
        value: `${runtimeProgress.percent}%`,
        meta: step >= steps.length ? tr("The on-device model is ready.", "本机模型已就绪。") : `${steps[step]}.`,
        percent: runtimeProgress.percent,
        stages: steps.map((name, index) =>
          index < step
            ? row(name, tr("Done", "完成"), "done")
            : index === step
              ? row(name, tr("Running", "进行中"), "active")
              : row(name, tr("Waiting", "等待中"), "idle")
        )
      };
    }

    if (stateId === "indexing" || stateId === "rebuilding") {
      const rebuilding = stateId === "rebuilding";
      const done = semanticProgress?.done ?? 0;
      const total = semanticProgress?.total ?? 0;
      const doneChunks = semanticProgress?.doneChunks ?? 0;
      const totalChunks = semanticProgress?.totalChunks ?? 0;
      const batches = Math.max(1, Math.ceil(totalChunks / EMBED_BATCH_TEXTS));
      const completedBatches = Math.min(batches, Math.ceil(doneChunks / EMBED_BATCH_TEXTS));
      const sealed = total > 0 && done >= total;
      return {
        label: rebuilding ? tr("Index rebuild", "索引重建") : tr("Semantic index", "语义索引"),
        value: total > 0 ? `${formatNumber(done)} / ${formatNumber(total)}` : tr("Preparing", "准备中"),
        // Before the first batch lands there is no count to report; the
        // batches themselves are ledger detail, not the line under the bar.
        meta:
          total > 0
            ? tr("Runs in the background. Close this panel whenever you like.", "在后台进行，随时可以关闭此面板。")
            : rebuilding
              ? tr("Every memo is queued for indexing.", "所有笔记已排队等待索引。")
              : tr("Counting the memos that still need indexing.", "正在统计仍需索引的笔记。"),
        percent: total > 0 ? (done / total) * 100 : 0,
        stages: [
          ...(rebuilding ? [row(tr("Previous index discarded", "已丢弃旧索引"), tr("Done", "完成"), "done")] : []),
          row(
            tr("Memos embedded", "已嵌入笔记"),
            tr(`${formatNumber(done)} of ${formatNumber(total)}`, `${formatNumber(done)} / ${formatNumber(total)}`),
            "active"
          ),
          row(
            tr("Batches processed", "已处理批次"),
            tr(`${completedBatches} of ${batches}`, `${completedBatches} / ${batches}`),
            completedBatches >= batches ? "done" : completedBatches > 0 ? "active" : "idle"
          ),
          row(tr("Sealed with the device key", "已用设备密钥加密"), sealed ? tr("Done", "完成") : tr("On write", "写入时"), sealed ? "done" : "idle")
        ]
      };
    }

    if (stateId === "searching" && semanticQueryProgress) {
      const understand = tr("Understand query", "理解查询");
      const rank = tr("Rank current view", "排序当前范围");
      if (semanticQueryProgress.stage !== "ranking") {
        const trimmed = semanticQuery.trim();
        return {
          label: tr("Understanding query", "理解查询"),
          value: tr("Step 1 of 2", "第 1 / 2 步"),
          meta: trimmed
            ? tr(`Embedding “${trimmed}” on this device.`, `正在此设备上嵌入「${trimmed}」。`)
            : tr("Embedding your query on this device.", "正在此设备上理解你的查询。"),
          percent: 35,
          stages: [row(understand, tr("Running", "进行中"), "active"), row(rank, tr("Waiting", "等待中"), "idle")]
        };
      }
      const { done, total } = semanticQueryProgress;
      const share = total > 0 ? done / total : 1;
      return {
        label: tr("Ranking current view", "排序当前范围"),
        value: `${formatNumber(done)} / ${formatNumber(total)}`,
        meta: tr("Keyword hits keep their place; related memos are added below.", "关键词命中保持原位；意思相关的笔记补充在后。"),
        percent: 50 + share * 50,
        stages: [row(understand, tr("Done", "完成"), "done"), row(rank, `${Math.floor(share * 100)}%`, "active")]
      };
    }

    return EMPTY_PROGRESS;
  })();

  const showProgress = progress.label !== "";
  const showAction = stateId === "idle" || stateId === "paused" || stateId === "failed";
  const canCancel = view.kind === "downloading";
  const orbMute = stateId === "checking" || stateId === "idle" || stateId === "paused" || stateId === "failed" || stateId === "clearing";

  /* Rebuilding is offered only where it can actually run and where it would
     not flicker: the model is live on this device, semantic search is on, and
     nothing is mid-flight. In "Ready" it is the one thing left to do here, so
     it fills the space the download CTA leaves behind; on a semantic failure
     it sits under the retry as the heavier second option. */
  const showRebuild =
    Boolean(onSemanticReindex) &&
    view.kind === "ready" &&
    (stateId === "ready" || stateId === "failed") &&
    (semanticStatus === "ready" || semanticStatus === "error");
  const indexedCount = formatNumber(semanticIndexedMemos);
  const rebuildNote =
    semanticIndexedMemos > 0
      ? tr(`${indexedCount} memos indexed`, `已索引 ${indexedCount} 条笔记`)
      : tr("Nothing indexed yet", "尚无索引内容");
  // Short enough to keep the ask, Cancel and Rebuild on the line the button
  // vacated: the row swaps in place instead of growing under the reader.
  const rebuildAsk =
    semanticIndexedMemos > 0
      ? tr(`Re-embed ${indexedCount} memos?`, `重新嵌入 ${indexedCount} 条笔记？`)
      : tr("Index every memo now?", "立即索引所有笔记？");

  const actionLabel =
    stateId === "failed"
      ? errorOrigin === "download"
        ? tr("Retry download", "重试下载")
        : errorOrigin === "semantic"
          ? tr("Retry semantic search", "重试语义搜索")
          : tr("Try again", "重试")
      : stateId === "paused" || idlePartial
        ? tr("Resume download", "继续下载")
        : tr("Download model", "下载模型");
  /* The size note appears only where bytes will actually move: a failed
     start has every file already, and says so by leaving the note off. */
  const needsDownload = stateId === "idle" || stateId === "paused" || (stateId === "failed" && errorOrigin === "download");
  const actionNote = !needsDownload
    ? ""
    : keptBytes > 0
      ? tr(`About ${wholeMb(TOTAL_BYTES - keptBytes)} MB remaining`, `还需约 ${wholeMb(TOTAL_BYTES - keptBytes)} MB`)
      : tr(`About ${wholeMb(TOTAL_BYTES)} MB · one time`, `约 ${wholeMb(TOTAL_BYTES)} MB · 仅需一次`);
  const onAction =
    errorOrigin === "clear"
      ? () => void clearModel()
      : errorOrigin === "semantic"
        ? () => onSemanticRetry?.()
        : () => void startModelDownload();

  /* This device's facts. While a download runs, files count as stored the
     moment their bytes are fully down (each is verified before storage), so
     the right column ticks with the bar instead of jumping at the end. */
  const displayStored: ReadonlySet<string> = (() => {
    if (view.kind !== "downloading") return present;
    const stored = new Set<string>();
    let sum = 0;
    for (const file of MODEL_MANIFEST.files) {
      sum += file.bytes;
      if (download.loadedBytes >= sum) stored.add(file.requestPath);
    }
    return stored;
  })();
  const displayStoredBytes = MODEL_MANIFEST.files.reduce(
    (sum, file) => sum + (displayStored.has(file.requestPath) ? file.bytes : 0),
    0
  );
  const fileCount = MODEL_MANIFEST.files.length;
  const filesLine =
    stateId === "checking"
      ? tr("Checking…", "检查中…")
      : displayStored.size === 0
        ? tr("None stored yet", "尚未存储")
        : tr(
            `${displayStored.size} of ${fileCount} · ${megabytes(displayStoredBytes)}`,
            `${displayStored.size} / ${fileCount} · ${megabytes(displayStoredBytes)}`
          );
  /* The index is a device fact too, and the only one the rebuild acts on —
     so it is named beside the model files rather than left implicit. */
  const indexFact =
    semanticStatus === "off"
      ? tr("Not in use", "未启用")
      : semanticIndexedMemos > 0
        ? tr(`${indexedCount} memos`, `${indexedCount} 条笔记`)
        : stateId === "indexing" || stateId === "rebuilding" || semanticStatus === "preparing"
          ? tr("Building…", "构建中…")
          : tr("Not built yet", "尚未构建");
  const storageLine =
    displayStored.size < 1
      ? tr(`0 of ${fileCount} files`, `0 / ${fileCount} 个文件`)
      : tr(
          `${displayStored.size} of ${fileCount} files · ${megabytes(displayStoredBytes)}`,
          `${displayStored.size} / ${fileCount} 个文件 · ${megabytes(displayStoredBytes)}`
        );

  /* ---- headline swap: the outgoing line lifts away as the new one rises - */

  const [oldHeadline, setOldHeadline] = useState<{ text: string; serial: number } | null>(null);
  const swapSerialRef = useRef(0);
  const lastHeadRef = useRef<{ id: StateId; text: string } | null>(null);
  const lastHead = lastHeadRef.current;
  if (lastHead !== null && lastHead.id !== stateId) {
    // Render-phase capture, same pattern as SwapText: the previous headline
    // becomes the exiting layer of this very render.
    swapSerialRef.current += 1;
    setOldHeadline({ text: lastHead.text, serial: swapSerialRef.current });
  }
  lastHeadRef.current = { id: stateId, text: headline };

  /* ---- attend: the Brain opened us to show this — wash and reveal it ---- */

  useEffect(() => {
    if (!attend) return;
    const frame = requestAnimationFrame(() => {
      const block = progressBlockRef.current;
      const box = scrollRef.current;
      if (block && box) box.scrollTop = Math.max(0, block.offsetTop - box.offsetTop - 24);
    });
    return () => cancelAnimationFrame(frame);
  }, [attend]);

  /* Collapsed regions hold focusable controls; `inert` (assigned via the
     DOM property — the JSX attribute lands with React 19) keeps them out of
     the tab order and the accessibility tree while they are folded shut. */
  useEffect(() => {
    if (progressBlockRef.current) progressBlockRef.current.inert = !showProgress;
  }, [showProgress]);
  useEffect(() => {
    if (stagesRegionRef.current) stagesRegionRef.current.inert = !(stagesOpen && showProgress);
  }, [stagesOpen, showProgress]);
  useEffect(() => {
    if (actionRegionRef.current) actionRegionRef.current.inert = !showAction;
  }, [showAction]);
  useEffect(() => {
    if (rebuildRegionRef.current) rebuildRegionRef.current.inert = !showRebuild;
  }, [showRebuild]);
  useEffect(() => {
    if (advRegionRef.current) advRegionRef.current.inert = !advOpen;
  }, [advOpen]);

  /* Cancel folds away with the progress block it sat in; keyboard focus
     carries over to the Resume it made room for. (After the inert effects,
     so the action region is already open to receive it.) */
  useEffect(() => {
    if (downloadPhase !== "cancelled" || !cancelledHereRef.current) return;
    cancelledHereRef.current = false;
    actionButtonRef.current?.focus({ preventScroll: true });
  }, [downloadPhase]);

  /* The confirm replaces the button that opened it, so keyboard focus has to
     be carried across; Cancel takes it, because the affirmative here spends
     minutes of this device's CPU and should never be one stray Space away.
     A rebuild starting (or any state change that folds the row) cancels it. */
  useEffect(() => {
    if (!showRebuild) setConfirmingRebuild(false);
  }, [showRebuild]);
  useEffect(() => {
    if (confirmingRebuild) rebuildConfirmRef.current?.focus();
  }, [confirmingRebuild]);

  return (
    <div
      ref={overlayRef}
      className={`overlay review-overlay${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={tr("Semantic Search", "语义搜索")}
      tabIndex={-1}
      onClick={requestClose}
    >
      <div className="model-panel" onClick={(event) => event.stopPropagation()}>
        <header className="model-panel-head">
          <h2 className="model-panel-title">{tr("Semantic Search", "语义搜索")}</h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-button model-panel-close"
            onClick={requestClose}
            aria-label={tr("Close", "关闭")}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div ref={scrollRef} className="model-panel-scroll">
          <div className="model-panel-columns">
            <div className="model-stage-col">
              <ThinkingOrb state={ORB[stateId]} size={112} mute={orbMute} />
              {/* The live region is the two lines that name the state — a bar
                  ticking every frame never re-announces the whole panel. */}
              <div className="model-live" role="status" aria-live="polite">
                <span className="model-headline-swap">
                  <span key={stateId} className="model-headline">
                    {headline}
                  </span>
                  {oldHeadline ? (
                    <span
                      key={`out-${oldHeadline.serial}`}
                      className="model-headline-prev"
                      aria-hidden="true"
                      onAnimationEnd={() => setOldHeadline(null)}
                    >
                      {oldHeadline.text}
                    </span>
                  ) : null}
                </span>
                <p key={`sub-${stateId}`} className="model-subline">
                  {subline}
                </p>
              </div>

              <div
                ref={progressBlockRef}
                className={`model-collapse model-progress-collapse${showProgress ? " is-open" : ""}`}
              >
                <div>
                  <div className="model-progress-pad">
                    <div
                      key={`box-${stateId}-${attend}`}
                      className={`model-progress-box${attend > 0 ? " is-attend" : ""}`}
                    >
                      <div className="model-progress-top">
                        <span key={`label-${stateId}`} className="model-progress-label">
                          {progress.label}
                        </span>
                        <span className="model-progress-value">{progress.value}</span>
                      </div>
                      <div
                        className="model-progress-track"
                        {...(showProgress
                          ? {
                              role: "progressbar",
                              "aria-valuemin": 0,
                              "aria-valuemax": 100,
                              "aria-valuenow": Math.max(0, Math.min(100, Math.round(progress.percent))),
                              "aria-valuetext": progress.value,
                              "aria-label": progress.label
                            }
                          : {})}
                      >
                        <span
                          className="model-progress-fill"
                          style={{ width: `${Math.max(0, Math.min(100, progress.percent)).toFixed(2)}%` }}
                        />
                      </div>
                      <p className="model-progress-meta">{progress.meta}</p>
                    </div>

                    <div className="model-stages">
                      <div className="model-stages-bar">
                        <button
                          type="button"
                          className="model-fold-toggle"
                          aria-expanded={stagesOpen}
                          aria-controls="model-stage-list"
                          onClick={() => setStagesOpen((open) => !open)}
                        >
                          <ChevronDown size={14} className="model-caret" aria-hidden="true" />
                          {tr("Stages", "阶段")}
                        </button>
                        {/* Stopping is a pause, not a loss — verified files
                            stay — so it wears the quiet ghost, never red. */}
                        {canCancel ? (
                          <button
                            type="button"
                            className="ghost-button model-cancel-download"
                            aria-label={tr("Cancel the download", "取消下载")}
                            onClick={() => {
                              cancelledHereRef.current = true;
                              cancelModelDownload();
                            }}
                          >
                            {tr("Cancel", "取消")}
                          </button>
                        ) : null}
                      </div>
                      <div
                        ref={stagesRegionRef}
                        id="model-stage-list"
                        className={`model-collapse model-stages-collapse${stagesOpen && showProgress ? " is-open" : ""}`}
                      >
                        <div>
                          <div key={`stages-${stateId}`} className="model-stage-list">
                            {progress.stages.map((stage) => (
                              <div key={stage.name} className="model-stage-row" data-tone={stage.tone}>
                                <span className="model-stage-dot" aria-hidden="true" />
                                <span className="model-stage-name">{stage.name}</span>
                                <span className="model-stage-note">{stage.note}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div
                ref={actionRegionRef}
                className={`model-collapse model-action-collapse${showAction ? " is-open" : ""}`}
              >
                <div>
                  <div className="model-action-row">
                    <button ref={actionButtonRef} type="button" className="model-cta" onClick={onAction}>
                      {stateId === "failed" ? (
                        <RefreshCw size={15} aria-hidden="true" />
                      ) : (
                        <Download size={15} aria-hidden="true" />
                      )}
                      {actionLabel}
                    </button>
                    {actionNote ? <span className="model-action-note">{actionNote}</span> : null}
                  </div>
                </div>
              </div>

              <div
                ref={rebuildRegionRef}
                className={`model-collapse model-rebuild-collapse${showRebuild ? " is-open" : ""}${
                  showAction ? " is-tight" : ""
                }`}
              >
                <div>
                  {confirmingRebuild ? (
                    <div
                      key="rebuild-confirm"
                      className="model-rebuild-row is-confirming"
                      role="group"
                      aria-label={tr("Confirm rebuilding the index", "确认重建索引")}
                    >
                      <span className="model-rebuild-ask">{rebuildAsk}</span>
                      {/* The pair travels together, so a narrow column drops
                          both buttons below the ask instead of splitting them. */}
                      <span className="model-rebuild-actions">
                        <button
                          ref={rebuildConfirmRef}
                          type="button"
                          className="ghost-button model-rebuild-cancel"
                          onClick={() => setConfirmingRebuild(false)}
                        >
                          {tr("Cancel", "取消")}
                        </button>
                        <button
                          type="button"
                          className="model-rebuild-go"
                          onClick={() => {
                            setConfirmingRebuild(false);
                            onSemanticReindex?.();
                          }}
                        >
                          {tr("Rebuild", "重建")}
                        </button>
                      </span>
                    </div>
                  ) : (
                    <div key="rebuild-rest" className="model-rebuild-row">
                      <button
                        type="button"
                        className="model-wash-button model-rebuild-button"
                        onClick={() => setConfirmingRebuild(true)}
                      >
                        <RefreshCw size={14} className="model-rebuild-icon" aria-hidden="true" />
                        {tr("Rebuild index", "重建索引")}
                      </button>
                      <span className="model-action-note">{rebuildNote}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <aside className="model-device-col">
              <span className="model-device-title">{tr("On this device", "本机")}</span>
              <div className="model-device-field">
                <span>{tr("Model", "模型")}</span>
                <code>{MODEL_MANIFEST.version}</code>
              </div>
              <div className="model-device-field">
                <span>{tr("Verified files", "已验证文件")}</span>
                <b className="model-device-files">{filesLine}</b>
              </div>
              <div className="model-device-field">
                <span>{tr("Semantic index", "语义索引")}</span>
                <b className="model-device-files">{indexFact}</b>
              </div>
              <span className="model-device-caps">{tr("Understands 52 languages", "支持 52 种语言")}</span>
              <p className="model-device-note">
                {tr(
                  "Every file is checked against a pinned SHA-256 hash before it is stored. Memo text and embeddings never leave this device.",
                  "每个文件在存储前都会核对固定的 SHA-256 哈希；笔记文本和向量不会离开此设备。"
                )}
              </p>
            </aside>
          </div>

          <div
            ref={advRegionRef}
            id="model-advanced"
            className={`model-collapse model-adv-collapse${advOpen ? " is-open" : ""}`}
          >
            <div>
              <div className="model-adv">
                <div className="model-adv-head">
                  <span className="model-adv-title">{tr("Device storage", "设备存储")}</span>
                  <span className="model-adv-total">{storageLine}</span>
                </div>
                <div className="model-files">
                  {MODEL_MANIFEST.files.map((file) => {
                    const here = displayStored.has(file.requestPath);
                    return (
                      <div key={file.requestPath} className="model-file-row">
                        <span className={`model-file-dot${here ? " is-present" : ""}`} aria-hidden="true" />
                        <span className="model-file-name">{file.asset}</span>
                        <span className="model-file-size">{fileSize(file.bytes)}</span>
                        <button
                          type="button"
                          className={`icon-button model-file-save${here ? "" : " is-absent"}`}
                          disabled={!present.has(file.requestPath) || busy}
                          onClick={() => void handleExportFile(file)}
                          aria-label={tr(`Save ${file.asset} to a file`, `将 ${file.asset} 保存为文件`)}
                        >
                          <FileDown size={15} aria-hidden="true" />
                        </button>
                      </div>
                    );
                  })}
                </div>
                <span className="model-adv-caps">{tr("384 dimensions · 8-bit quantized", "384 维 · 8 位量化")}</span>
                {errorDetail ? (
                  /* The raw reason, for whoever needs it — beside the ledger,
                     never in the headline. */
                  <div className="model-error-detail">
                    <span className="model-error-detail-label">{tr("Last error", "最近一次错误")}</span>
                    <ul className="model-failures">
                      {errorDetail.failures.length > 0 ? (
                        errorDetail.failures.map((failure) => (
                          <li key={failure.url}>
                            {failureHost(failure.url)} — {failure.reason}
                          </li>
                        ))
                      ) : (
                        <li>{errorDetail.message}</li>
                      )}
                    </ul>
                  </div>
                ) : null}
                <div className="model-adv-actions">
                  <button
                    type="button"
                    className="model-wash-button"
                    disabled={busy}
                    onClick={() => importInputRef.current?.click()}
                  >
                    <Upload size={15} aria-hidden="true" />
                    {tr("Import files", "导入文件")}
                  </button>
                  <button
                    type="button"
                    className="model-wash-button is-danger"
                    disabled={present.size === 0 || busy}
                    onClick={() => setConfirmingClear(true)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                    {tr("Clear model", "清除模型")}
                  </button>
                </div>
                {importNote ? (
                  <p className="model-note" role="status">
                    {importNote}
                  </p>
                ) : null}
                {clearNote ? (
                  <p className="model-note model-clear-note" role="status">
                    {clearNote}
                  </p>
                ) : null}
                {confirmingClear ? (
                  <div className="model-clear-confirm" role="group" aria-label={tr("Confirm clearing the model", "确认清除模型")}>
                    <span className="model-clear-confirm-icon" aria-hidden="true">
                      <HardDrive size={17} />
                    </span>
                    <span className="model-clear-confirm-copy">
                      <strong>{tr("Clear model from this device?", "从此设备清除模型？")}</strong>
                      <span>
                        {tr(
                          "This removes the model files and encrypted semantic index. You can download them again later.",
                          "这会删除模型文件和加密语义索引，之后仍可重新下载。"
                        )}
                      </span>
                    </span>
                    <span className="model-clear-confirm-actions">
                      <button type="button" className="ghost-button" onClick={() => setConfirmingClear(false)}>
                        {tr("Cancel", "取消")}
                      </button>
                      <button type="button" className="danger-button" onClick={() => void clearModel()}>
                        {tr("Clear model", "清除模型")}
                      </button>
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <footer className="model-panel-foot">
          <button
            type="button"
            className="model-fold-toggle"
            aria-expanded={advOpen}
            aria-controls="model-advanced"
            onClick={() => setAdvOpen((open) => !open)}
          >
            <ChevronDown size={14} className="model-caret" aria-hidden="true" />
            {tr("Advanced", "高级")}
          </button>
          <span className="model-foot-spacer" />
          <button type="button" className="model-foot-close" onClick={requestClose}>
            {tr("Close", "关闭")}
          </button>
        </footer>

        <input
          ref={importInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = event.target.files;
            void handleImport(files);
            event.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
