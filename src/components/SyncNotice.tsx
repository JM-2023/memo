import { Check, CloudOff, Loader2, WifiOff } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../lib/i18n";
import { announce } from "../lib/liveAnnouncer";
import { EXIT_MS } from "../lib/motion";
import { parkFocusOnMain } from "./ScrollTopButton";

export interface SyncNoticeContent {
  /** What the line is about; a new kind starts its retry state afresh. */
  kind: "loading" | "load-failed" | "offline" | "unreachable";
  text: string;
  /**
   * The same words as `text` with their figures rolling (RollingText), as
   * every other live count in the chrome does. Shown to the eye only; `text`
   * stays the copy assistive tech reads.
   */
  line?: ReactNode;
  /** Said instead of `text` once a retry didn't help. */
  failedText?: string;
  /** The reader's "try again"; resolves whether it got through (void: unknown). */
  onRetry?: () => Promise<boolean> | void;
}

type Shown = SyncNoticeContent | { kind: "restored"; text: string; line?: undefined; failedText?: undefined; onRetry?: undefined };

/** A retry reads as one even when the answer is instant. */
const RETRY_MIN_MS = 600;
/** How long "Back online" stays before the line folds away. */
const RESTORED_MS = 1_400;
/** The fold away (a fade alone under reduced motion, app.css), plus a frame. */
const LEAVE_MS = EXIT_MS;

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

/**
 * The link to the server, when it needs saying: the cold-start loading line,
 * offline, or pulls failing while online. A retry shows that it is running
 * (and says so in words when it didn't help); the connection coming back is
 * said once ("Back online"), and the line then folds its height away rather
 * than letting the composer and feed jump up by its height. It arrives the
 * same way, unfolding from nothing (app.css, @starting-style), so the page
 * under it glides down instead of being pushed.
 *
 * Under reduced motion it keeps the same phases: the line fades in and out
 * where it stands and its room opens and closes at once (app.css), never a
 * cut.
 *
 * Not a live region: it mounts with its text, so the app's standing regions
 * speak it (App announces the notice itself; the retry outcome and "Back
 * online" are announced here).
 */
export function SyncNotice({ notice }: { notice: SyncNoticeContent | null }) {
  const { tr } = useI18n();
  const kind = notice?.kind ?? null;
  const [shownKind, setShownKind] = useState(kind);
  const [exit, setExit] = useState<{ content: Shown; phase: "restored" | "leaving" } | null>(null);
  const [retry, setRetry] = useState<{ kind: string; phase: "running" | "failed" } | null>(null);
  const lastRef = useRef<SyncNoticeContent | null>(notice);
  const retryTokenRef = useRef(0);
  const mountedRef = useRef(true);
  const restoredText = tr("Back online", "已恢复连接");

  if (kind !== shownKind) {
    setShownKind(kind);
    setRetry(null);
    if (notice) setExit(null);
    else if (shownKind === "offline" || shownKind === "unreachable") setExit({ content: { kind: "restored", text: restoredText }, phase: "restored" });
    else setExit(!lastRef.current ? null : { content: lastRef.current, phase: "leaving" });
  }
  if (notice) lastRef.current = notice;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A late answer to a retry belongs to the line it was asked on.
  useEffect(() => {
    retryTokenRef.current += 1;
  }, [kind]);

  useEffect(() => {
    if (!exit) return;
    if (exit.phase === "restored") {
      announce(exit.content.text);
      const timer = window.setTimeout(() => setExit({ content: exit.content, phase: "leaving" }), RESTORED_MS);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => setExit(null), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [exit]);

  const shown: Shown | null = notice ?? exit?.content ?? null;
  if (!shown) return null;
  const leaving = !notice && exit?.phase === "leaving";
  const retryPhase = notice && retry?.kind === notice.kind ? retry.phase : null;
  const retrying = retryPhase === "running";

  async function runRetry() {
    const current = notice;
    if (!current?.onRetry || retrying || leaving) return;
    const token = ++retryTokenRef.current;
    setRetry({ kind: current.kind, phase: "running" });
    const started = performance.now();
    let ok: boolean | undefined;
    try {
      const answer = await current.onRetry();
      ok = typeof answer === "boolean" ? answer : undefined;
    } catch {
      ok = false;
    }
    const rest = RETRY_MIN_MS - (performance.now() - started);
    if (rest > 0) await wait(rest);
    if (!mountedRef.current || token !== retryTokenRef.current) return;
    setRetry(ok === false ? { kind: current.kind, phase: "failed" } : null);
    if (ok === false && current.failedText) announce(current.failedText);
  }

  const icon =
    shown.kind === "restored" ? (
      <Check size={14} aria-hidden="true" />
    ) : retrying || shown.kind === "loading" ? (
      <Loader2 size={14} className="spin" aria-hidden="true" />
    ) : shown.kind === "offline" ? (
      <WifiOff size={14} aria-hidden="true" />
    ) : (
      <CloudOff size={14} aria-hidden="true" />
    );
  const failed = retryPhase === "failed" && shown.failedText;
  const text = failed || shown.text;
  const line = !failed ? shown.line : undefined;

  return (
    <div className={`sync-notice-slot${leaving ? " is-leaving" : ""}`}>
      <div className="sync-notice-clip">
        <div className={`sync-notice${shown.kind === "restored" ? " is-restored" : ""}`}>
          {icon}
          {line ? (
            <span className="sync-notice-text">
              <span className="sr-only">{text}</span>
              <span aria-hidden="true">{line}</span>
            </span>
          ) : (
            <span className="sync-notice-text">{text}</span>
          )}
          {shown.onRetry ? (
            <RetryButton busy={retrying || leaving} onRetry={() => void runRetry()}>
              {/* Both words share one cell, so the button keeps its width. */}
              <span className="busy-swap">
                <span aria-hidden={retrying || undefined}>{tr("Retry", "重试")}</span>
                <span aria-hidden={!retrying || undefined}>{tr("Retrying…", "正在重试…")}</span>
              </span>
            </RetryButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The line's one verb. Busy (retrying, or the line folding away) it is
 * aria-disabled rather than disabled: the press that started a retry keeps
 * its focus instead of dropping it to <body>, and runRetry guards itself.
 * The button can still go while focused — the connection came back, or the
 * line folded — so focus is parked on the main column first, the way the
 * back-to-top disc hands it over.
 */
function RetryButton({ busy, onRetry, children }: { busy: boolean; onRetry: () => void; children: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  // A layout cleanup runs before React takes the node out, while it still
  // holds focus.
  useLayoutEffect(() => {
    const button = ref.current;
    return () => {
      if (button && document.activeElement === button) parkFocusOnMain();
    };
  }, []);
  return (
    <button ref={ref} type="button" className="sync-notice-retry" aria-disabled={busy || undefined} onClick={onRetry}>
      {children}
    </button>
  );
}
