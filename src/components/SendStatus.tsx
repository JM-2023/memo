import { CircleAlert, CloudOff, Loader2, WifiOff } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../lib/i18n";
import { BUSY_HOLD_MS, EASE_OUT, EXIT_MS, T_SLOW } from "../lib/motion";
import type { SendState } from "../lib/outbox";

export type SendStatusKind = SendState | "sent";
export type SendStatusSurface = "card" | "toast";
type Translate = (en: string, zh: string) => string;

/**
 * The one bilingual vocabulary for a memo's send lifecycle, shared by the
 * card header, the hidden-view toast and screen-reader announcements.
 * Every stage speaks in the "Send / 发送" family — never mixing "Sending",
 * "didn't send" and "Saved" for the same event.
 */
export function sendStatusLabel(state: SendStatusKind, tr: Translate, surface: SendStatusSurface = "card"): string {
  if (surface === "toast") {
    switch (state) {
      case "sending":
        return tr("Sending… — this view hides it", "发送中…，当前视图下看不到它");
      case "retrying":
        return tr("Not sent · retrying — this view hides it", "未发送 · 正在重试，当前视图下看不到它");
      case "failed":
        return tr("Not sent · will retry when you’re online — this view hides it", "未发送 · 联网后会自动补发，当前视图下看不到它");
      case "refused":
        return tr("Not sent · the server refused it — this view hides it", "未发送 · 服务器未接受，当前视图下看不到它");
      case "sent":
        return tr("Sent — this view hides it", "已发送，当前视图下看不到它");
    }
  }
  switch (state) {
    case "sending":
      return tr("Sending…", "发送中…");
    case "retrying":
      return tr("Not sent · retrying", "未发送 · 正在重试");
    case "failed":
      return tr("Not sent · will retry when you’re online", "未发送 · 联网后会自动补发");
    case "refused":
      return tr("Not sent · the server refused it", "未发送 · 服务器未接受");
    case "sent":
      return tr("Sent", "已发送");
  }
}

/** Only a server refusal carries error tone; offline and retrying stay calm neutral. */
export function sendStatusTone(state: SendStatusKind): "info" | "error" {
  return state === "refused" ? "error" : "info";
}

/**
 * Coordinates the busy hold (BUSY_HOLD_MS) and settling exit (EXIT_MS) on a
 * card header so its status label and action buttons reveal and exit in step.
 * Fast sends that settle inside the hold never flash "Sending…" or expose an
 * invisible "Take back" button.
 */
export function useSendHold(state: SendState | undefined): { holding: boolean; settling: boolean } {
  const [prevState, setPrevState] = useState(state);
  const [revealed, setRevealed] = useState(() => state !== "sending");
  const [settling, setSettling] = useState(false);

  if (state !== prevState) {
    setPrevState(state);
    if (state === "sending") {
      setRevealed(false);
      setSettling(false);
    } else if (!state && prevState) {
      setRevealed(true);
      setSettling(true);
    } else {
      setRevealed(true);
      setSettling(false);
    }
  }

  useEffect(() => {
    if (state !== "sending" || revealed) return;
    const timer = window.setTimeout(() => setRevealed(true), BUSY_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [state, revealed]);

  useEffect(() => {
    if (!settling) return;
    const timer = window.setTimeout(() => setSettling(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [settling]);

  return { holding: state === "sending" && !revealed, settling };
}

interface BoxSize {
  width: number;
  height: number;
}

/** The box's laid-out size, blind to transforms (matches SwapText). */
function layoutSize(el: HTMLElement): BoxSize | null {
  const style = window.getComputedStyle(el);
  const width = parseFloat(style.width);
  const height = parseFloat(style.height);
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
}

function statusClass(state: SendStatusKind | null, surface: SendStatusSurface, tone: "info" | "error"): string {
  const base = surface === "toast" ? "send-status-face is-toast" : "memo-send-state send-status-face";
  if (!state) return `${base}${tone === "error" ? " is-refused" : " is-sent"}`;
  switch (state) {
    case "sending":
      return `${base} is-sending`;
    case "retrying":
      return `${base} is-retrying`;
    case "failed":
      return `${base} is-failed`;
    case "refused":
      return `${base} is-refused`;
    case "sent":
      return `${base} is-sent`;
  }
}

interface StatusFaceProps {
  state: SendStatusKind | null;
  surface: SendStatusSurface;
  tone: "info" | "error";
  text: string;
  id?: string;
  extraClass?: string;
  ariaHidden?: boolean;
  width?: number | null;
  faceRef?: React.RefObject<HTMLSpanElement>;
}

function StatusFace({ state, surface, tone, text, id, extraClass = "", ariaHidden, width, faceRef }: StatusFaceProps) {
  const mark =
    state === "sending" ? (
      <Loader2 size={surface === "toast" ? 14 : 11} className="spin send-status-icon" aria-hidden="true" />
    ) : state === "failed" ? (
      <WifiOff size={surface === "toast" ? 14 : 12} className="send-status-icon" aria-hidden="true" />
    ) : state === "retrying" ? (
      <CloudOff size={surface === "toast" ? 14 : 12} className="send-status-icon" aria-hidden="true" />
    ) : state === "refused" || (!state && tone === "error") ? (
      surface === "toast" ? (
        <CircleAlert size={15} className="toast-mark" aria-hidden="true" />
      ) : (
        <span className="memo-send-dot" aria-hidden="true" />
      )
    ) : null;

  return (
    <span
      ref={faceRef}
      id={id}
      className={`${statusClass(state, surface, tone)}${extraClass ? ` ${extraClass}` : ""}`}
      style={width ? { width: `${width}px` } : undefined}
      aria-hidden={ariaHidden || undefined}
    >
      {mark}
      <span className={surface === "toast" ? "send-status-text toast-text" : "memo-send-text send-status-text"}>{text}</span>
    </span>
  );
}

interface LeavingFace {
  serial: number;
  state: SendStatusKind | null;
  tone: "info" | "error";
  text: string;
  width: number | null;
}

export interface SendStatusProps {
  /** Current send state; null/undefined on a card renders `settled` (the timestamp). */
  state: SendStatusKind | null | undefined;
  /** Where it sits: compact card header or width-tweening hidden-view toast. */
  surface: SendStatusSurface;
  /** True during the card's 150ms busy hold: keeps Sending… unshown so fast sends never flash it. */
  holding?: boolean;
  /** Card header's aria-labelledby id. */
  id?: string;
  /** Card header's settled content (its <time>) once the server confirms the send. */
  settled?: ReactNode;
  /** Toast-only: plain text when a hidden-view send toast is revised into another notice (e.g. ⌘Z). */
  overrideText?: string;
  /** Toast-only: tone for `overrideText`. */
  overrideTone?: "info" | "error";
}

/**
 * Shared send-status presentation for both a card header and the hidden-view
 * toast. Only server refusals use danger red; offline and retrying states stay
 * calm muted gray. Every transition crossfades cleanly (tweening toast width
 * under full motion and dissolving cleanly under prefers-reduced-motion).
 */
export function SendStatus({ state, surface, holding = false, id, settled, overrideText, overrideTone = "info" }: SendStatusProps) {
  const { tr } = useI18n();
  const activeState: SendStatusKind | null = state ?? null;
  const text = activeState ? sendStatusLabel(activeState, tr, surface) : (overrideText ?? "");
  const tone: "info" | "error" = activeState ? sendStatusTone(activeState) : overrideTone;

  const visibleKey =
    surface === "card"
      ? activeState
        ? holding
          ? "holding"
          : activeState
        : "settled"
      : activeState
        ? activeState
        : `text:${tone}:${text}`;

  const boxRef = useRef<HTMLSpanElement>(null);
  const curRef = useRef<HTMLSpanElement>(null);
  const fromSizeRef = useRef<BoxSize | null>(null);
  const sizeAnimRef = useRef<Animation | null>(null);
  const serialRef = useRef(0);
  const lastRef = useRef<{ key: string; state: SendStatusKind | null; tone: "info" | "error"; text: string } | null>(null);
  const [leaving, setLeaving] = useState<LeavingFace | null>(null);

  const last = lastRef.current;
  if (last !== null && last.key !== visibleKey) {
    // Capture the leaving face before React commits the new one so the box
    // tweens from its exact current width (toast) and crossfades cleanly.
    const size = surface === "toast" && boxRef.current ? layoutSize(boxRef.current) : null;
    fromSizeRef.current = size;
    if (last.key !== "holding" && last.key !== "settled") {
      serialRef.current += 1;
      setLeaving({
        serial: serialRef.current,
        state: last.state,
        tone: last.tone,
        text: last.text,
        width: size ? size.width : null
      });
    }
  }
  lastRef.current = { key: visibleKey, state: activeState, tone, text };

  // A timer, not animationend: an off-screen slot (content-visibility) never
  // runs CSS animations, and its outgoing layer must still unmount.
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(null), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  // Toast width/height tween: morphs the content-sized toast pill smoothly
  // between states (e.g. "Sending… — this view hides it" → "Sent — this view
  // hides it") without snapping; reduced motion dissolves in place instead.
  useLayoutEffect(() => {
    if (surface !== "toast") return;
    const el = boxRef.current;
    const from = fromSizeRef.current;
    fromSizeRef.current = null;
    sizeAnimRef.current?.cancel();
    sizeAnimRef.current = null;
    if (!el || !from || typeof el.animate !== "function") return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = layoutSize(el);
    if (!to) return;
    const start: Keyframe = {};
    const end: Keyframe = {};
    if (Math.abs(to.width - from.width) >= 1) {
      start.width = `${from.width}px`;
      end.width = `${to.width}px`;
    }
    if (Math.abs(to.height - from.height) >= 1) {
      start.height = `${from.height}px`;
      end.height = `${to.height}px`;
    }
    if (Object.keys(end).length === 0) return;
    const cur = curRef.current;
    if (cur) cur.style.width = `${to.width + 0.01}px`;
    const unpin = () => {
      if (cur) cur.style.width = "";
    };
    const animation = el.animate([start, end], { duration: T_SLOW, easing: EASE_OUT });
    sizeAnimRef.current = animation;
    void animation.finished.then(
      () => {
        unpin();
        if (sizeAnimRef.current === animation) sizeAnimRef.current = null;
      },
      () => unpin()
    );
    return () => {
      unpin();
      if (sizeAnimRef.current !== animation) return;
      animation.cancel();
      sizeAnimRef.current = null;
    };
  }, [surface, visibleKey]);

  if (surface === "card") {
    // Fast path for the thousands of settled cards in the feed: no wrapper.
    if (!activeState && !leaving) return <>{settled}</>;
    return (
      <span ref={boxRef} className="send-status-swap memo-stamp-swap">
        {activeState ? (
          <StatusFace
            key={holding ? "holding" : activeState}
            state={activeState}
            surface="card"
            tone={tone}
            text={text}
            id={id}
            extraClass={holding ? "is-holding" : "is-entering"}
          />
        ) : (
          settled
        )}
        {leaving ? (
          <StatusFace
            key={`leave-${leaving.serial}`}
            state={leaving.state}
            surface="card"
            tone={leaving.tone}
            text={leaving.text}
            extraClass="is-leaving"
            ariaHidden
          />
        ) : null}
      </span>
    );
  }

  const entered = serialRef.current > 0;
  return (
    <span ref={boxRef} className="send-status-swap is-toast">
      <StatusFace
        faceRef={curRef}
        key={visibleKey}
        state={activeState}
        surface="toast"
        tone={tone}
        text={text}
        extraClass={entered ? "is-entering" : ""}
      />
      {leaving ? (
        <StatusFace
          key={`leave-${leaving.serial}`}
          state={leaving.state}
          surface="toast"
          tone={leaving.tone}
          text={leaving.text}
          extraClass="is-leaving"
          ariaHidden
          width={leaving.width}
        />
      ) : null}
    </span>
  );
}

type ActionGroup = "sending" | "failed" | "none";

export interface SendStatusActionsProps {
  state: SendState | undefined;
  /** True during the 150ms busy hold of "sending": Take back is inert, disabled and unfocusable. */
  holding: boolean;
  recallBlocked?: boolean;
  onTakeBack?: () => void;
  onRetrySend?: () => void;
  onDiscardUnsent?: () => void;
}

/**
 * The card header's send actions ("Take back" while sending; "Retry / Edit /
 * Discard" once failed). Failed, retrying and refused all map to one stable
 * group so automatic retries never swap or jiggle the buttons under the
 * reader's pointer. Hidden/holding and exiting button groups are inert,
 * disabled, unfocusable and pointer-events: none so an invisible "Take back"
 * can never intercept a click meant for "Discard".
 */
export function SendStatusActions({ state, holding, recallBlocked, onTakeBack, onRetrySend, onDiscardUnsent }: SendStatusActionsProps) {
  const { tr } = useI18n();
  const group: ActionGroup = !state ? "none" : state === "sending" ? (holding ? "none" : "sending") : "failed";
  const [prevGroup, setPrevGroup] = useState<ActionGroup>(group);
  const [leaving, setLeaving] = useState<{ group: "sending" | "failed"; serial: number } | null>(null);
  const serialRef = useRef(0);
  const holdRef = useRef<HTMLDivElement>(null);
  const leaveRef = useRef<HTMLDivElement>(null);

  if (group !== prevGroup) {
    setPrevGroup(group);
    if (prevGroup !== "none") {
      serialRef.current += 1;
      setLeaving({ group: prevGroup, serial: serialRef.current });
    }
  }

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(null), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  const showHolding = state === "sending" && holding;
  useLayoutEffect(() => {
    if (holdRef.current) holdRef.current.inert = true;
  }, [showHolding]);
  useLayoutEffect(() => {
    if (leaveRef.current) leaveRef.current.inert = true;
  }, [leaving]);

  if (group === "none" && !showHolding && !leaving) return null;

  const renderButtons = (kind: "sending" | "failed", live: boolean) =>
    kind === "sending" ? (
      <button
        type="button"
        className="memo-send-action"
        disabled={!live}
        tabIndex={live ? undefined : -1}
        aria-disabled={live && recallBlocked ? true : undefined}
        onClick={live ? onTakeBack : undefined}
      >
        {tr("Take back", "撤回")}
      </button>
    ) : (
      <>
        <button type="button" className="memo-send-action is-primary" disabled={!live} tabIndex={live ? undefined : -1} onClick={live ? onRetrySend : undefined}>
          {tr("Retry", "重试")}
        </button>
        <button
          type="button"
          className="memo-send-action"
          disabled={!live}
          tabIndex={live ? undefined : -1}
          aria-disabled={live && recallBlocked ? true : undefined}
          onClick={live ? onTakeBack : undefined}
        >
          {tr("Edit", "编辑")}
        </button>
        <button type="button" className="memo-send-action" disabled={!live} tabIndex={live ? undefined : -1} onClick={live ? onDiscardUnsent : undefined}>
          {tr("Discard", "舍弃")}
        </button>
      </>
    );

  return (
    <>
      {showHolding ? (
        <div ref={holdRef} className="memo-send-actions is-holding" aria-hidden="true">
          {renderButtons("sending", false)}
        </div>
      ) : group !== "none" ? (
        <div key={group} className="memo-send-actions is-entering">
          {renderButtons(group, true)}
        </div>
      ) : null}
      {leaving ? (
        <div ref={leaveRef} key={`leave-${leaving.serial}`} className="memo-send-actions is-leaving" aria-hidden="true">
          {renderButtons(leaving.group, false)}
        </div>
      ) : null}
    </>
  );
}
