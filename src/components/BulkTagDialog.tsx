import { Hash, Loader2, Tags, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useModalA11y } from "../hooks/useModalA11y";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { useI18n } from "../lib/i18n";
import { isValidTagPath } from "../lib/tags";

interface BulkTagDialogProps {
  /** Memos the tag will land on; 0 keeps the sheet inert. */
  selectedCount: number;
  /** "selection" is select mode's batch, "memo" one card's ⋯ menu. */
  scope?: "selection" | "memo";
  knownTags: string[];
  /** Tags the single target already carries — applying one would be a no-op. */
  ownedTags?: string[];
  /** Performs the requests but defers the visual commit until the dialog exits. */
  onApply: (tag: string) => Promise<boolean>;
  /** Cancelled after the exit animation. */
  onDismiss: () => void;
  /** Successful request batch, called after the exit animation. */
  onApplied: () => void;
}

const NO_OWNED_TAGS: string[] = [];

function normalizeTag(value: string): string {
  return value.trim().replace(/^#+/, "");
}

/**
 * A focused tag picker, shared by select mode's batch and a single card's ⋯
 * menu. Network work happens while the sheet is present; the parent commits
 * changed cards only after its exit has finished, giving the feed transition a
 * clean second beat instead of animating behind the overlay.
 */
export function BulkTagDialog({ selectedCount, scope = "selection", knownTags, ownedTags = NO_OWNED_TAGS, onApply, onDismiss, onApplied }: BulkTagDialogProps) {
  const { count, tr } = useI18n();
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const closeTimer = useRef(0);
  const dismissRef = useRef(onDismiss);
  const appliedRef = useRef(onApplied);
  dismissRef.current = onDismiss;
  appliedRef.current = onApplied;

  const tag = normalizeTag(value);
  const error = tag && !isValidTagPath(tag) ? tr("Use letters, numbers, _, -, · and / between levels.", "标签可使用文字、数字、_、-、·，层级之间用 /。") : null;
  const exact = knownTags.includes(tag);
  const owned = useMemo(() => new Set(ownedTags), [ownedTags]);
  // A tag the target already carries is worth neither a suggestion nor a
  // request: appending it is a no-op the user would read as a failure.
  const alreadyOwned = Boolean(tag) && owned.has(tag);
  const suggestions = useMemo(() => {
    const query = normalizeTag(value).toLocaleLowerCase();
    return knownTags.filter((item) => !owned.has(item) && (!query || item.toLocaleLowerCase().includes(query))).slice(0, 8);
  }, [knownTags, owned, value]);
  const canSubmit = selectedCount > 0 && Boolean(tag) && !error && !alreadyOwned && !submitting && !closing;
  const noteKey = error
    ? "validation-error"
    : applyError
      ? "apply-error"
      : tag
        ? `${alreadyOwned ? "owned" : exact ? "existing" : "new"}:${tag}`
        : "empty";

  function leave(callback: () => void) {
    if (closing) return;
    if (reducedMotion) {
      callback();
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(callback, 170);
  }

  function requestDismiss() {
    if (submitting || closing) return;
    leave(() => dismissRef.current());
  }

  const overlayRef = useModalA11y<HTMLDivElement>({
    onEscape: requestDismiss,
    escapeDisabled: submitting,
    initialFocusRef: inputRef
  });

  useEffect(() => {
    inputRef.current?.focus();
    return () => window.clearTimeout(closeTimer.current);
  }, []);

  async function submit() {
    if (!canSubmit) return;
    setApplyError(null);
    setSubmitting(true);
    let exitsBusy = false;
    try {
      const settled = await onApply(tag);
      if (settled) {
        // Keep the settled busy presentation through modal-out. Dropping back
        // to the editable form during those final 160ms creates a visible
        // label/button flash and briefly re-enables controls under the exit.
        exitsBusy = true;
        leave(() => appliedRef.current());
      } else {
        setApplyError(tr("Couldn’t add the tag. Check your connection and try again.", "添加标签失败，请检查网络后重试。"));
      }
    } catch {
      setApplyError(tr("Couldn’t add the tag. Check your connection and try again.", "添加标签失败，请检查网络后重试。"));
    } finally {
      if (!exitsBusy) setSubmitting(false);
    }
  }

  return (
    <div
      ref={overlayRef}
      className={`overlay bulk-tag-overlay${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={scope === "memo" ? tr("Add tag to this memo", "为这条笔记添加标签") : tr("Add tag to selected memos", "为所选笔记添加标签")}
      aria-busy={submitting || undefined}
      tabIndex={-1}
      onClick={requestDismiss}
    >
      <div className="confirm-card bulk-tag-card" onClick={(event) => event.stopPropagation()}>
        <header className="bulk-tag-head">
          <span className="bulk-tag-mark" aria-hidden="true">
            <Tags size={17} />
          </span>
          <div>
            <h2>{tr("Add a tag", "添加标签")}</h2>
            <p>
              {scope === "memo"
                ? tr("Apply one tag to this memo.", "为这条笔记添加一个标签。")
                : tr(`Apply one tag to ${count(selectedCount, "memo")}.`, `为已选的 ${count(selectedCount, "memo")} 添加同一个标签。`)}
            </p>
          </div>
          <button type="button" className="icon-button bulk-tag-close" onClick={requestDismiss} disabled={submitting} aria-label={tr("Close", "关闭")}>
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <form
          className="bulk-tag-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className={`bulk-tag-field${error || applyError ? " is-error" : ""}`}>
            <Hash size={16} aria-hidden="true" />
            <input
              ref={inputRef}
              aria-label={tr("Tag", "标签")}
              value={value}
              placeholder={tr("project/alpha", "项目/阶段")}
              spellCheck={false}
              autoComplete="off"
              disabled={submitting || closing}
              aria-invalid={Boolean(error || applyError) || undefined}
              onChange={(event) => {
                setValue(event.target.value);
                setApplyError(null);
              }}
            />
          </label>

          <div className="bulk-tag-note" aria-live="polite">
            {error ? (
              <span key={noteKey} className="is-error" role="alert">
                {error}
              </span>
            ) : applyError ? (
              <span key={noteKey} className="is-error" role="alert">
                {applyError}
              </span>
            ) : alreadyOwned ? (
              // Only reachable with `ownedTags`, which today means memo scope.
              <span key={noteKey}>
                {tr("Already on this memo", "笔记中已有")} · <strong>#{tag}</strong>
              </span>
            ) : tag ? (
              <span key={noteKey}>
                {exact ? tr("Existing tag", "已有标签") : tr("New tag", "新标签")} · <strong>#{tag}</strong>
              </span>
            ) : (
              <span key={noteKey}>{tr("Choose an existing tag or type a new one.", "选择已有标签，或输入一个新标签。")}</span>
            )}
          </div>

          <div className={`bulk-tag-suggestions-shell${suggestions.length > 0 ? " is-open" : ""}`} aria-hidden={suggestions.length === 0 || undefined}>
            <div className="bulk-tag-suggestions" role="group" aria-label={tr("Tag suggestions", "标签建议")}>
              {suggestions.map((item, index) => (
                <button
                  key={item}
                  type="button"
                  className={item === tag ? "is-active" : ""}
                  style={{ animationDelay: `${Math.min(index, 5) * 0.015}s` }}
                  disabled={submitting || closing}
                  onClick={() => {
                    setValue(item);
                    inputRef.current?.focus();
                  }}
                >
                  #{item}
                </button>
              ))}
            </div>
          </div>

          <footer className="bulk-tag-actions">
            <button type="button" className="ghost-button" onClick={requestDismiss} disabled={submitting}>
              {tr("Cancel", "取消")}
            </button>
            <button type="submit" className="accent-button bulk-tag-submit" disabled={!canSubmit}>
              {submitting ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Tags size={15} aria-hidden="true" />}
              <span>{submitting ? tr("Adding…", "添加中…") : tr("Add tag", "添加标签")}</span>
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
