import {
  Check,
  CircleAlert,
  Cpu,
  Download,
  FileDown,
  HardDrive,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useModalA11y } from "../hooks/useModalA11y";
import { useReducedMotion } from "../hooks/useReducedMotion";
import type { SemanticQueryProgress, SemanticSearchStatus } from "../hooks/useSemanticSearch";
import { useI18n } from "../lib/i18n";
import {
  clearModelFiles,
  ensureModelFiles,
  importModelFiles,
  ModelUnavailableError,
  presentModelFiles,
  readModelFileBytes,
  storedModelState,
  type MirrorFailure
} from "../lib/modelLoader";
import { MODEL_MANIFEST, modelTotalBytes, type ModelFileSpec } from "../lib/modelManifest";
import {
  getEmbedder,
  getModelRuntimeProgress,
  resetModelRuntime,
  runModelSelfTest,
  subscribeModelRuntimeProgress
} from "../lib/modelRuntime";
import { deleteSemanticIndexDb } from "../lib/semanticIndex";

interface ModelSettingsModalProps {
  onClose: () => void;
  onModelCleared: () => void;
  /** Completes a Brain-toggle request that first had to download the model. */
  onModelReady?: () => void;
  semanticStatus?: SemanticSearchStatus;
  semanticProgress?: { done: number; total: number } | null;
  semanticQueryProgress?: SemanticQueryProgress | null;
}

type Phase =
  | { kind: "checking" }
  | { kind: "idle"; stored: "none" | "partial" }
  | { kind: "downloading"; loadedBytes: number }
  | { kind: "activating" }
  | { kind: "clearing" }
  | { kind: "ready" }
  | { kind: "error"; message: string; failures: readonly MirrorFailure[] };

const TOTAL_BYTES = modelTotalBytes();
const TOTAL_MB = Math.round(TOTAL_BYTES / 1e6);

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

interface ProgressBarProps {
  label: string;
  detail: string;
  percent: number;
  ariaLabel: string;
}

function ModelProgressBar({ label, detail, percent, ariaLabel }: ProgressBarProps) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="model-progress-wrap">
      <div className="model-progress-meta">
        <span>{label}</span>
        <span>{detail}</span>
      </div>
      <div
        className="model-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={detail}
        aria-label={ariaLabel}
      >
        <span className="model-progress-fill" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

/**
 * Download, verify, activate, import, and export the on-device embedding
 * model. "Ready" is only shown after a real self-test inference on this
 * device; everything else surfaces as an explicit state with a next step.
 * The modal follows the review-settings dialog's shell and motion language.
 */
export function ModelSettingsModal({
  onClose,
  onModelCleared,
  onModelReady,
  semanticStatus = "off",
  semanticProgress = null,
  semanticQueryProgress = null
}: ModelSettingsModalProps) {
  const { tr } = useI18n();
  const reducedMotion = useReducedMotion();
  const runtimeProgress = useSyncExternalStore(
    subscribeModelRuntimeProgress,
    getModelRuntimeProgress,
    getModelRuntimeProgress
  );

  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [present, setPresent] = useState<ReadonlySet<string>>(() => new Set());
  const [importNote, setImportNote] = useState<string | null>(null);
  const [clearNote, setClearNote] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [closing, setClosing] = useState(false);

  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const dismissTimer = useRef(0);
  const disposedRef = useRef(false);
  const readyReportedRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const modelReadyRef = useRef(onModelReady);
  modelReadyRef.current = onModelReady;

  const safeSetPhase = useCallback((next: Phase) => {
    if (!disposedRef.current) setPhase(next);
  }, []);

  const refreshPresence = useCallback(async () => {
    const files = await presentModelFiles();
    if (!disposedRef.current) setPresent(files);
    return files;
  }, []);

  const activate = useCallback(async () => {
    safeSetPhase({ kind: "activating" });
    try {
      await getEmbedder();
      await runModelSelfTest();
      if (!disposedRef.current) {
        setPhase({ kind: "ready" });
        if (!readyReportedRef.current) {
          readyReportedRef.current = true;
          modelReadyRef.current?.();
        }
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      safeSetPhase({
        kind: "error",
        message: tr(`The model couldn't start on this device. (${detail})`, `模型在此设备上启动失败。（${detail}）`),
        failures: []
      });
    }
  }, [safeSetPhase, tr]);

  const download = useCallback(async () => {
    setClearNote(null);
    safeSetPhase({ kind: "downloading", loadedBytes: 0 });
    try {
      await ensureModelFiles((progress) => {
        safeSetPhase({ kind: "downloading", loadedBytes: progress.loadedBytes });
      });
      await refreshPresence();
      await activate();
    } catch (cause) {
      await refreshPresence();
      if (cause instanceof ModelUnavailableError) {
        safeSetPhase({
          kind: "error",
          message: tr("The model couldn't be downloaded from any source.", "无法从任何下载源获取模型。"),
          failures: cause.failures
        });
      } else {
        const detail = cause instanceof Error ? cause.message : String(cause);
        safeSetPhase({
          kind: "error",
          message: tr(`The download failed. (${detail})`, `下载失败。（${detail}）`),
          failures: []
        });
      }
    }
  }, [activate, refreshPresence, safeSetPhase, tr]);

  useEffect(() => {
    disposedRef.current = false;
    void (async () => {
      await refreshPresence();
      const stored = await storedModelState();
      if (disposedRef.current) return;
      if (stored === "complete") await activate();
      else safeSetPhase({ kind: "idle", stored });
    })();
    return () => {
      disposedRef.current = true;
      window.clearTimeout(dismissTimer.current);
    };
  }, [activate, refreshPresence, safeSetPhase]);

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
      if (complete && phase.kind !== "ready") await activate();
    } catch {
      if (!disposedRef.current) setImportNote(tr("Couldn't read those files.", "无法读取所选文件。"));
    }
  }

  async function handleClearModel() {
    setConfirmingClear(false);
    setImportNote(null);
    setClearNote(null);
    safeSetPhase({ kind: "clearing" });
    onModelCleared();
    try {
      await Promise.all([resetModelRuntime(), clearModelFiles(), deleteSemanticIndexDb()]);
      if (disposedRef.current) return;
      setPresent(new Set());
      setClearNote(tr("Model and semantic index cleared from this device.", "已从此设备清除模型和语义索引。"));
      safeSetPhase({ kind: "idle", stored: "none" });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      safeSetPhase({
        kind: "error",
        message: tr(`The model couldn't be cleared. (${detail})`, `无法清除模型。（${detail}）`),
        failures: []
      });
    }
  }

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

  const busy = phase.kind === "checking" || phase.kind === "downloading" || phase.kind === "activating" || phase.kind === "clearing";
  const percent = phase.kind === "downloading" ? Math.min(100, Math.floor((phase.loadedBytes / TOTAL_BYTES) * 100)) : 0;
  const storedBytes = MODEL_MANIFEST.files.reduce((sum, file) => sum + (present.has(file.requestPath) ? file.bytes : 0), 0);
  const hasStoredFiles = present.size > 0;
  const showRuntimeProgress = phase.kind === "activating" || semanticStatus === "preparing";
  const runtimeStageText = (() => {
    switch (runtimeProgress.stage) {
      case "loading-code":
        return tr("Loading the private search engine.", "正在加载本地搜索引擎。");
      case "loading-files":
        return tr("Reading verified model files from device storage.", "正在从设备存储读取已验证的模型文件。");
      case "starting-runtime":
      case "runtime-ready":
        return tr("Starting the single-thread background inference worker.", "正在启动单线程后台推理 Worker。");
      case "self-testing":
        return tr("Checking multilingual results with a real inference.", "正在通过真实推理检查多语言结果。");
      case "ready":
        return tr("The on-device model is ready.", "本机模型已就绪。");
      case "error":
        return tr("The model runtime needs attention.", "模型运行时需要处理。");
      case "idle":
        return tr("Preparing the on-device model.", "正在准备本机模型。");
    }
  })();
  const indexPercent =
    semanticProgress && semanticProgress.total > 0 ? (semanticProgress.done / semanticProgress.total) * 100 : 0;
  const queryPercent = semanticQueryProgress
    ? semanticQueryProgress.stage === "waiting"
      ? 4
      : semanticQueryProgress.stage === "embedding"
        ? 35
        : semanticQueryProgress.total > 0
          ? 50 + (semanticQueryProgress.done / semanticQueryProgress.total) * 50
          : 100
    : 0;
  const queryLabel =
    semanticQueryProgress?.stage === "waiting"
      ? tr("Waiting To Search", "等待检索")
      : semanticQueryProgress?.stage === "embedding"
        ? tr("Understanding Query", "理解查询")
        : tr("Ranking Current View", "排序当前范围");
  const queryDetail =
    semanticQueryProgress?.stage === "waiting"
      ? tr("Queued", "已排队")
      : semanticQueryProgress?.stage === "embedding"
        ? tr("Step 1 Of 2", "第 1 / 2 步")
        : `${semanticQueryProgress?.done ?? 0} / ${semanticQueryProgress?.total ?? 0} ${tr("Rows", "行")}`;
  const semanticActivityActive =
    phase.kind === "ready" &&
    (semanticStatus === "preparing" || semanticStatus === "indexing" || semanticQueryProgress !== null);

  const statusTitle =
    phase.kind === "checking"
      ? tr("Checking Device", "正在检查设备")
      : phase.kind === "idle"
        ? phase.stored === "partial"
          ? tr("Download Incomplete", "下载未完成")
          : tr("Not Downloaded", "尚未下载")
        : phase.kind === "downloading"
          ? tr("Downloading Model", "正在下载模型")
          : phase.kind === "activating"
            ? runtimeProgress.stage === "self-testing"
              ? tr("Verifying Model", "正在验证模型")
              : tr("Loading Model", "正在加载模型")
            : phase.kind === "clearing"
              ? tr("Clearing Model", "正在清除模型")
              : phase.kind === "ready"
                ? semanticStatus === "preparing"
                  ? tr("Preparing Semantic Search", "正在准备语义搜索")
                  : semanticStatus === "indexing"
                    ? tr("Building Search Index", "正在构建搜索索引")
                    : semanticQueryProgress
                      ? tr("Searching Current View", "正在搜索当前范围")
                      : tr("Ready", "已就绪")
                : tr("Action Needed", "需要处理");

  const statusText =
    phase.kind === "checking"
      ? tr("Looking for verified model files on this device.", "正在查找此设备上的已验证模型文件。")
      : phase.kind === "idle"
        ? phase.stored === "partial"
          ? tr("Some verified files are present. Resume to finish the download.", "已有部分已验证文件，可以继续下载。")
          : tr("Download the model to search your memos by meaning.", "下载模型后即可按意思搜索笔记。")
        : phase.kind === "downloading"
          ? tr(`${megabytes(phase.loadedBytes)} of ${megabytes(TOTAL_BYTES)}`, `${megabytes(phase.loadedBytes)} / ${megabytes(TOTAL_BYTES)}`)
          : phase.kind === "activating"
            ? runtimeStageText
            : phase.kind === "clearing"
              ? tr("Removing model files and the encrypted semantic index.", "正在删除模型文件和加密语义索引。")
              : phase.kind === "ready"
                ? semanticStatus === "preparing"
                  ? runtimeStageText
                  : semanticStatus === "indexing"
                    ? tr(
                        "Embedding memos in the background. Keyword search and the rest of the app remain available.",
                        "正在后台为笔记生成向量；关键词搜索和应用其他功能仍可使用。"
                      )
                    : semanticQueryProgress?.stage === "ranking"
                      ? tr("Ranking only memos inside the current view.", "仅对当前范围内的笔记进行排序。")
                      : semanticQueryProgress
                        ? tr("Understanding your query on this device.", "正在此设备上理解你的查询。")
                        : tr("Verified on this device and available offline.", "已在此设备上验证，可离线使用。")
                : phase.message;

  const statusIcon =
    semanticActivityActive ? (
      <Loader2 size={17} className="spin" aria-hidden="true" />
    ) : phase.kind === "ready" ? (
      <Check size={17} aria-hidden="true" />
    ) : phase.kind === "error" ? (
      <CircleAlert size={17} aria-hidden="true" />
    ) : busy ? (
      <Loader2 size={17} className="spin" aria-hidden="true" />
    ) : (
      <Download size={17} aria-hidden="true" />
    );

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
      <div className="review-modal model-modal" onClick={(event) => event.stopPropagation()}>
        <header className="review-head model-head">
          <span className="review-head-logo" aria-hidden="true">
            <Cpu size={15} />
          </span>
          <div className="model-head-copy">
            <h2>{tr("Semantic Search", "语义搜索")}</h2>
            <p>{tr("Private, multilingual search on this device", "此设备上的私密多语言搜索")}</p>
          </div>
          <button ref={closeButtonRef} type="button" className="icon-button review-close" onClick={requestClose} aria-label={tr("Close", "关闭")}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="review-body model-body">
          <section className="review-section model-overview">
            <div className={`model-status-card is-${semanticActivityActive ? "working" : phase.kind}`} role="status" aria-live="polite">
              <span className="model-status-icon" aria-hidden="true">
                {statusIcon}
              </span>
              <span className="model-status-copy">
                <strong>{statusTitle}</strong>
                <span>{statusText}</span>
              </span>
            </div>
            {phase.kind === "downloading" || showRuntimeProgress || semanticStatus === "indexing" || semanticQueryProgress ? (
              <div className="model-activity-stack" aria-live="polite">
                {phase.kind === "downloading" ? (
                  <ModelProgressBar
                    label={tr("Download Progress", "下载进度")}
                    detail={`${percent}%`}
                    percent={percent}
                    ariaLabel={tr("Download Progress", "下载进度")}
                  />
                ) : null}
                {showRuntimeProgress && phase.kind !== "downloading" ? (
                  <ModelProgressBar
                    label={tr("Model Loading Progress", "模型加载进度")}
                    detail={`${runtimeProgress.percent}%`}
                    percent={runtimeProgress.percent}
                    ariaLabel={tr("Model Loading Progress", "模型加载进度")}
                  />
                ) : null}
                {semanticStatus === "indexing" ? (
                  <ModelProgressBar
                    label={tr("Semantic Index Progress", "语义索引进度")}
                    detail={
                      semanticProgress
                        ? `${semanticProgress.done} / ${semanticProgress.total} ${tr("Memos", "条笔记")}`
                        : tr("Preparing", "准备中")
                    }
                    percent={indexPercent}
                    ariaLabel={tr("Semantic Index Progress", "语义索引进度")}
                  />
                ) : null}
                {semanticQueryProgress ? (
                  <ModelProgressBar
                    label={queryLabel}
                    detail={queryDetail}
                    percent={queryPercent}
                    ariaLabel={tr("Semantic Search Progress", "语义搜索进度")}
                  />
                ) : null}
              </div>
            ) : null}
            {phase.kind === "error" && phase.failures.length > 0 ? (
              <ul className="model-failures">
                {phase.failures.slice(0, 3).map((failure) => (
                  <li key={failure.url}>
                    {failureHost(failure.url)} — {failure.reason}
                  </li>
                ))}
              </ul>
            ) : null}
            {phase.kind === "idle" ? (
              <div className="model-actions">
                <button type="button" className="accent-button" onClick={() => void download()}>
                  <Download size={15} aria-hidden="true" />
                  {phase.stored === "partial"
                    ? tr("Resume Download", "继续下载")
                    : tr("Download Model", "下载模型")}
                </button>
                <span className="model-action-size">{tr(`About ${TOTAL_MB} MB`, `约 ${TOTAL_MB} MB`)}</span>
              </div>
            ) : null}
            {phase.kind === "error" ? (
              <div className="model-actions">
                <button type="button" className="accent-button" onClick={() => void download()}>
                  <RefreshCw size={15} aria-hidden="true" />
                  {tr("Retry Download", "重试下载")}
                </button>
              </div>
            ) : null}
            <div className="model-facts" role="list" aria-label={tr("Model Capabilities", "模型能力")}>
              <span role="listitem">
                <ShieldCheck size={14} aria-hidden="true" />
                {tr("On Device", "本机运行")}
              </span>
              <span role="listitem">{tr("52 Languages", "52 种语言")}</span>
              <span role="listitem">{tr("384 Dimensions", "384 维")}</span>
            </div>
            <p className="model-note model-privacy-note">
              {tr(
                "Every file is checked against a pinned SHA-256 hash before storage. Memo text and embeddings stay on this device.",
                "每个文件都会在存储前核对固定的 SHA-256 哈希；笔记文本和向量始终留在此设备上。"
              )}
            </p>
          </section>

          <section className="review-section model-storage" style={{ animationDelay: "0.04s" }}>
            <div className="model-section-head">
              <h3 className="review-section-title">{tr("Device Storage", "设备存储")}</h3>
              <span className="model-storage-total">
                {present.size}/{MODEL_MANIFEST.files.length} {tr("Files", "个文件")} · {megabytes(storedBytes)}
              </span>
            </div>
            <ul className="model-files">
              {MODEL_MANIFEST.files.map((file) => {
                const here = present.has(file.requestPath);
                return (
                  <li key={file.requestPath} className="model-file-row">
                    <span className={`model-file-dot${here ? " is-present" : ""}`} aria-hidden="true" />
                    <span className="model-file-name">{file.asset}</span>
                    <span className="model-file-size">{fileSize(file.bytes)}</span>
                    <button
                      type="button"
                      className="icon-button"
                      disabled={!here || busy}
                      onClick={() => void handleExportFile(file)}
                      aria-label={tr(`Save ${file.asset} to a file`, `将 ${file.asset} 保存为文件`)}
                    >
                      <FileDown size={15} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="model-storage-actions">
              <button type="button" className="ghost-button" disabled={busy} onClick={() => importInputRef.current?.click()}>
                <Upload size={15} aria-hidden="true" />
                {tr("Import Files", "导入文件")}
              </button>
              <button
                type="button"
                className="ghost-button model-clear-trigger"
                disabled={!hasStoredFiles || busy}
                onClick={() => setConfirmingClear(true)}
              >
                <Trash2 size={15} aria-hidden="true" />
                {tr("Clear Model", "清除模型")}
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
              <div className="model-clear-confirm" role="group" aria-label={tr("Confirm Clear Model", "确认清除模型")}>
                <span className="model-clear-confirm-icon" aria-hidden="true">
                  <HardDrive size={17} />
                </span>
                <span className="model-clear-confirm-copy">
                  <strong>{tr("Clear Model From This Device?", "从此设备清除模型？")}</strong>
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
                  <button type="button" className="danger-button" onClick={() => void handleClearModel()}>
                    {tr("Clear Model", "清除模型")}
                  </button>
                </span>
              </div>
            ) : null}
          </section>
        </div>

        <footer className="review-foot">
          <div className="model-version">
            <span>{tr("Model Version", "模型版本")}</span>
            <code>{MODEL_MANIFEST.version}</code>
          </div>
          <div className="review-foot-actions">
            <button type="button" className="ghost-button" onClick={requestClose}>
              {tr("Close", "关闭")}
            </button>
          </div>
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
