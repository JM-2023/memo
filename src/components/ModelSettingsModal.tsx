import { Check, Cpu, Download, FileDown, RefreshCw, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useModalA11y } from "../hooks/useModalA11y";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { useI18n } from "../lib/i18n";
import {
  ensureModelFiles,
  importModelFiles,
  ModelUnavailableError,
  presentModelFiles,
  readModelFileBytes,
  storedModelState,
  type MirrorFailure
} from "../lib/modelLoader";
import { MODEL_MANIFEST, modelTotalBytes, type ModelFileSpec } from "../lib/modelManifest";
import { getEmbedder, runModelSelfTest } from "../lib/modelRuntime";

interface ModelSettingsModalProps {
  onClose: () => void;
}

type Phase =
  | { kind: "checking" }
  | { kind: "idle"; stored: "none" | "partial" }
  | { kind: "downloading"; loadedBytes: number }
  | { kind: "activating" }
  | { kind: "ready" }
  | { kind: "error"; message: string; failures: readonly MirrorFailure[] };

const TOTAL_BYTES = modelTotalBytes();
const TOTAL_MB = Math.round(TOTAL_BYTES / 1e6);

function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function failureHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Download, verify, activate, import, and export the on-device embedding
 * model. "Ready" is only shown after a real self-test inference on this
 * device; everything else surfaces as an explicit state with a next step.
 * The modal follows the review-settings dialog's shell and motion language.
 */
export function ModelSettingsModal({ onClose }: ModelSettingsModalProps) {
  const { tr } = useI18n();
  const reducedMotion = useReducedMotion();

  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [present, setPresent] = useState<ReadonlySet<string>>(() => new Set());
  const [importNote, setImportNote] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);

  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const dismissTimer = useRef(0);
  const disposedRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

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
      safeSetPhase({ kind: "ready" });
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

  const busy = phase.kind === "checking" || phase.kind === "downloading" || phase.kind === "activating";
  const percent = phase.kind === "downloading" ? Math.min(100, Math.floor((phase.loadedBytes / TOTAL_BYTES) * 100)) : 0;

  const statusText =
    phase.kind === "checking"
      ? tr("Checking this device…", "正在检查本机状态…")
      : phase.kind === "idle"
        ? phase.stored === "partial"
          ? tr("Partially downloaded — resume when ready.", "已下载一部分，可继续下载。")
          : tr("Not downloaded on this device yet.", "本机尚未下载模型。")
        : phase.kind === "downloading"
          ? tr(`Downloading… ${megabytes(phase.loadedBytes)} of ${megabytes(TOTAL_BYTES)}`, `下载中… ${megabytes(phase.loadedBytes)} / ${megabytes(TOTAL_BYTES)}`)
          : phase.kind === "activating"
            ? tr("Verifying on this device…", "正在本机验证…")
            : phase.kind === "ready"
              ? tr("Ready — verified on this device. Works offline.", "已就绪——本机验证通过，离线可用。")
              : phase.message;

  return (
    <div
      ref={overlayRef}
      className={`overlay review-overlay${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={tr("Semantic search", "语义搜索")}
      tabIndex={-1}
      onClick={requestClose}
    >
      <div className="review-modal model-modal" onClick={(event) => event.stopPropagation()}>
        <header className="review-head">
          <span className="review-head-logo" aria-hidden="true">
            <Cpu size={15} />
          </span>
          <h2>{tr("Semantic search", "语义搜索")}</h2>
          <button ref={closeButtonRef} type="button" className="icon-button review-close" onClick={requestClose} aria-label={tr("Close", "关闭")}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="review-body">
          <section className="review-section">
            <h3 className="review-section-title">{tr("Status", "状态")}</h3>
            <div className={`model-status${phase.kind === "error" ? " is-error" : ""}`} role="status" aria-live="polite">
              {phase.kind === "ready" ? <Check size={15} aria-hidden="true" /> : null}
              <span>{statusText}</span>
            </div>
            {phase.kind === "downloading" ? (
              <div
                className="model-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label={tr("Download progress", "下载进度")}
              >
                <span className="model-progress-fill" style={{ width: `${percent}%` }} />
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
                    ? tr(`Resume download (~${TOTAL_MB} MB)`, `继续下载（约 ${TOTAL_MB} MB）`)
                    : tr(`Download model (~${TOTAL_MB} MB)`, `下载模型（约 ${TOTAL_MB} MB）`)}
                </button>
              </div>
            ) : null}
            {phase.kind === "error" ? (
              <div className="model-actions">
                <button type="button" className="accent-button" onClick={() => void download()}>
                  <RefreshCw size={15} aria-hidden="true" />
                  {tr("Retry", "重试")}
                </button>
              </div>
            ) : null}
            <p className="model-note">
              {tr(
                "Downloaded once from this project's GitHub release (Hugging Face as fallback), verified against pinned checksums, then stored on this device. Nothing you write ever leaves it.",
                "模型只需从本项目的 GitHub Release 下载一次（失败时回退 Hugging Face），经固定校验和验证后存储在本机。你写下的内容永远不会离开设备。"
              )}
            </p>
          </section>

          <section className="review-section" style={{ animationDelay: "0.03s" }}>
            <h3 className="review-section-title">{tr("Model files", "模型文件")}</h3>
            <ul className="model-files">
              {MODEL_MANIFEST.files.map((file) => {
                const here = present.has(file.requestPath);
                return (
                  <li key={file.requestPath} className="model-file-row">
                    <span className={`model-file-dot${here ? " is-present" : ""}`} aria-hidden="true" />
                    <span className="model-file-name">{file.asset}</span>
                    <span className="model-file-size">{megabytes(file.bytes)}</span>
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
            <div className="model-actions">
              <button type="button" className="ghost-button" disabled={busy} onClick={() => importInputRef.current?.click()}>
                <Upload size={15} aria-hidden="true" />
                {tr("Import from files", "从文件导入")}
              </button>
            </div>
            {importNote ? (
              <p className="model-note" role="status">
                {importNote}
              </p>
            ) : null}
            <p className="model-note">
              {tr(
                "Files saved here (or the release assets themselves) can be imported on another device — matching is by content hash, so names don't matter.",
                "在这里保存的文件（或 Release 里的原始文件）可以在其他设备上导入——按内容哈希匹配，文件名无关紧要。"
              )}
            </p>
          </section>
        </div>

        <footer className="review-foot">
          <div className="model-version">
            {MODEL_MANIFEST.id} · {MODEL_MANIFEST.version}
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
