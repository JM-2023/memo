import { useEffect, useReducer, useRef, useState } from "react";
import { BUSY_HOLD_MS } from "../lib/motion";
import type { EditorSubmission } from "../components/Editor";
import type { NewImagePayload } from "../lib/types";

/**
 * The phases of a submission:
 * - Create mode: idle → preparing (waiting on images) → landing (card entering the feed) → idle
 * - Edit mode:   idle → preparing (waiting on images) → saving (server round trip) → error | idle
 */
export type SubmissionPhase = "idle" | "preparing" | "landing" | "saving" | "error";

export interface SubmissionError {
  text: string;
  seq: number;
}

export interface SubmissionState {
  phase: SubmissionPhase;
  /** Edit mode: whole percent of image upload (0..99), null while none is running. */
  uploadPercent: number | null;
  /** Edit mode: the last failed save's note while in the `error` phase. */
  error: SubmissionError | null;
}

export type SubmissionAction =
  | { type: "PREPARE" }
  | { type: "START"; mode: "create" | "edit"; tracksUpload: boolean }
  | { type: "PROGRESS"; percent: number }
  | { type: "STOP" }
  | { type: "FAIL"; mode: "create" | "edit"; text: string; seq: number }
  | { type: "SETTLE" }
  | { type: "CLEAR_ERROR" };

export const INITIAL_SUBMISSION: SubmissionState = {
  phase: "idle",
  uploadPercent: null,
  error: null
};

/** Pure state transitions for create and edit submissions. */
export function submissionReducer(state: SubmissionState, action: SubmissionAction): SubmissionState {
  switch (action.type) {
    case "PREPARE":
      if (state.phase !== "idle" && state.phase !== "error") return state;
      return { phase: "preparing", uploadPercent: null, error: null };
    case "START":
      if (state.phase === "landing" || state.phase === "saving") return state;
      return {
        phase: action.mode === "create" ? "landing" : "saving",
        uploadPercent: action.mode === "edit" && action.tracksUpload ? 0 : null,
        error: null
      };
    case "PROGRESS":
      if (state.phase !== "saving") return state;
      if (state.uploadPercent === action.percent) return state;
      return { ...state, uploadPercent: action.percent };
    case "STOP":
      if (state.phase !== "preparing") return state;
      return INITIAL_SUBMISSION;
    case "FAIL":
      if (action.mode === "edit") {
        return { phase: "error", uploadPercent: null, error: { text: action.text, seq: action.seq } };
      }
      return INITIAL_SUBMISSION;
    case "SETTLE":
      return state.phase === "idle" && state.uploadPercent === null && state.error === null ? state : INITIAL_SUBMISSION;
    case "CLEAR_ERROR":
      return state.phase === "error" ? INITIAL_SUBMISSION : state;
  }
}

/**
 * Single lock selector: whether the draft is frozen against edits.
 * Create mode's `landing` is intentionally NOT locked — the field stays
 * editable so the reader can start typing their next memo while the previous
 * one lands through the feed.
 */
export function isLockedPhase(phase: SubmissionPhase, busy: boolean): boolean {
  return busy || phase === "preparing" || phase === "saving";
}

/** Whether a send or save is currently active (blocks a duplicate submit or recall). */
export function isInFlightPhase(phase: SubmissionPhase): boolean {
  return phase === "preparing" || phase === "landing" || phase === "saving";
}

/**
 * Extracts what the user newly typed into `prev` to produce `next`, so typing
 * in the composer while a just-sent memo is still landing carries cleanly
 * into the next draft instead of mixing with the sent text or being wiped.
 */
export function extractTypedDelta(prev: string, next: string, inputData?: string | null): string {
  if (prev === next) return typeof inputData === "string" ? inputData : "";
  const max = Math.min(prev.length, next.length);
  let head = 0;
  while (head < max && prev.charCodeAt(head) === next.charCodeAt(head)) head += 1;
  let tail = 0;
  while (tail < max - head && prev.charCodeAt(prev.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)) tail += 1;
  // Never split a surrogate pair at either seam.
  if (head > 0 && /[\ud800-\udbff]/.test(prev[head - 1])) head -= 1;
  if (tail > 0 && /[\udc00-\udfff]/.test(prev[prev.length - tail])) tail -= 1;
  return next.slice(head, next.length - tail);
}

export interface HeldSelection {
  start: number;
  end: number;
  scrollTop: number;
}

export interface SubmissionDraft {
  rawContent: string;
  content: string;
  newImages: NewImagePayload[];
  removeImageIds: string[];
  selection: { start: number; end: number };
  held: HeldSelection | null;
}

interface ActiveLanding {
  rawContent: string;
  handedOff: boolean;
  controller: AbortController;
}

export interface UseSubmissionOptions {
  mode: "create" | "edit";
  busy: boolean;
  compressing: number;
  dirty: boolean;
  ready: boolean;
  hasPayload: boolean;
  mountedRef: { readonly current: boolean };
  readDraft: () => SubmissionDraft;
  onSubmit: (data: EditorSubmission) => Promise<boolean>;
  onCloseClean?: () => void;
  onBeforeStart?: () => void;
  onQueued?: () => void;
  onStoppedQueued?: () => void;
  onCommitEmpty: (animated: boolean, rawContent: string) => void;
  onHandoff: () => void;
  onRestoreField: (held: HeldSelection | null) => void;
  onReturnFocus: () => void;
  onError: (cause: unknown) => SubmissionError;
}

/**
 * Manages the editor's send / save lifecycle through an explicit phase
 * machine (`submissionReducer`), exposing a single `stop()` for Esc, the
 * Stop button and touch, and a single lock predicate (`locked` / `isLocked`)
 * so every handler agrees on when the draft is held.
 */
export function useSubmission({
  mode,
  busy,
  compressing,
  dirty,
  ready,
  hasPayload,
  mountedRef,
  readDraft,
  onSubmit,
  onCloseClean,
  onBeforeStart,
  onQueued,
  onStoppedQueued,
  onCommitEmpty,
  onHandoff,
  onRestoreField,
  onReturnFocus,
  onError
}: UseSubmissionOptions) {
  const [state, dispatch] = useReducer(submissionReducer, INITIAL_SUBMISSION);
  // Synchronous mirror of state.phase and busy so event handlers running
  // before the next commit read the live transition, never a stale closure.
  const phaseRef = useRef<SubmissionPhase>(state.phase);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // Stable across ambiguous failures; rotated only when a create lands or
  // hands off to the next draft, keeping retries idempotent.
  const draftIdRef = useRef(crypto.randomUUID());
  // The request or landing in flight, until it commits or settles; stop()
  // aborts it through this.
  const abortRef = useRef<AbortController | null>(null);
  // Create mode: tracks the memo currently landing so typing in the editable
  // field can pivot cleanly to the next draft without losing keystrokes or
  // letting a later onCommitted wipe them.
  const landingRef = useRef<ActiveLanding | null>(null);
  const [landingCommitted, setLandingCommitted] = useState(false);
  const [spinnerShown, setSpinnerShown] = useState(false);

  // Latest render values for async callbacks and effects.
  const latestRef = useRef({
    mode,
    busy,
    compressing,
    dirty,
    ready,
    hasPayload,
    readDraft,
    onSubmit,
    onCloseClean,
    onBeforeStart,
    onQueued,
    onStoppedQueued,
    onCommitEmpty,
    onHandoff,
    onRestoreField,
    onReturnFocus,
    onError
  });
  latestRef.current = {
    mode,
    busy,
    compressing,
    dirty,
    ready,
    hasPayload,
    readDraft,
    onSubmit,
    onCloseClean,
    onBeforeStart,
    onQueued,
    onStoppedQueued,
    onCommitEmpty,
    onHandoff,
    onRestoreField,
    onReturnFocus,
    onError
  };

  function transition(action: SubmissionAction) {
    const next = submissionReducer({ phase: phaseRef.current, uploadPercent: null, error: null }, action);
    phaseRef.current = next.phase;
    dispatch(action);
  }

  const sending = isInFlightPhase(state.phase);
  const locked = isLockedPhase(state.phase, busy);
  const isLocked = () => isLockedPhase(phaseRef.current, busyRef.current);
  const isInFlight = () => isInFlightPhase(phaseRef.current);

  const canSubmit = ready && !sending && compressing === 0 && hasPayload;
  // Send/Save pressed while images are still preparing is held in `preparing`
  // and goes out on its own once the last image lands.
  const canQueue = ready && !sending && compressing > 0;
  // Whether the Stop button is shown (saving in edit mode, or waiting on
  // images in either mode — phones have no Esc).
  const showStopButton = state.phase === "preparing" || state.phase === "saving";
  // Whether stop() currently has something to halt (also covers pre-commit
  // landing in create mode for Esc).
  const canStop = showStopButton || (state.phase === "landing" && !landingCommitted);
  // While the outgoing memo's tiles are still waiting for the view transition
  // capture, keep those tiles steady until commit or handoff clears them.
  const landingHoldingTiles = state.phase === "landing" && !landingCommitted;

  // Sending reads the same as resting for a beat (--t-hold): a fast round
  // trip never flashes the spinner, a slow one fades it in.
  useEffect(() => {
    if (!sending) {
      setSpinnerShown(false);
      return;
    }
    const timer = window.setTimeout(() => setSpinnerShown(true), BUSY_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [sending]);

  // A queued send/save (`preparing`) goes out as soon as the last image has
  // landed; one that can no longer go (a failure or conflict arrived) drops.
  useEffect(() => {
    if (state.phase !== "preparing" || compressing > 0) return;
    const latest = latestRef.current;
    if (latest.ready && latest.hasPayload) void runSubmit();
    else transition({ type: "SETTLE" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, compressing]);

  /**
   * Create mode: if a memo is mid-landing and hasn't handed off yet, returns
   * its raw text so typing can split off the newly entered characters.
   */
  function landingRawContent(): string | null {
    const landing = landingRef.current;
    return phaseRef.current === "landing" && landing && !landing.handedOff ? landing.rawContent : null;
  }

  /**
   * Create mode: the user started writing the next draft before `onCommitted`
   * fired. Hand off the outgoing memo now (rotate clientId, clear sent tiles,
   * disarm Esc abort) so `onCommitted` leaves the new draft intact.
   */
  function handoffLanding(): boolean {
    const landing = landingRef.current;
    if (phaseRef.current !== "landing" || !landing || landing.handedOff) return false;
    landing.handedOff = true;
    if (abortRef.current === landing.controller) abortRef.current = null;
    draftIdRef.current = crypto.randomUUID();
    setLandingCommitted(true);
    latestRef.current.onHandoff();
    return true;
  }

  /** Executes the send (create) or save (edit) request. */
  async function runSubmit() {
    if (phaseRef.current === "landing" || phaseRef.current === "saving") return;
    const latest = latestRef.current;
    const draft = latest.readDraft();
    const tracksUpload = latest.mode === "edit" && draft.newImages.length > 0;
    const controller = new AbortController();
    abortRef.current = controller;
    if (latest.mode === "create") {
      landingRef.current = { rawContent: draft.rawContent, handedOff: false, controller };
      setLandingCommitted(false);
    } else {
      landingRef.current = null;
    }
    latest.onBeforeStart?.();
    transition({ type: "START", mode: latest.mode, tracksUpload });

    const commitEmpty = (animated: boolean) => {
      const landing = landingRef.current;
      if (!landing || landing.controller !== controller || landing.handedOff || !mountedRef.current) return;
      landing.handedOff = true;
      // Landed: from here Esc has nothing left to stop.
      if (abortRef.current === controller) abortRef.current = null;
      draftIdRef.current = crypto.randomUUID();
      setLandingCommitted(true);
      latestRef.current.onCommitEmpty(animated, landing.rawContent);
    };

    let failedInEdit = false;
    try {
      const ok = await latest.onSubmit({
        clientId: draftIdRef.current,
        content: draft.content,
        newImages: draft.newImages,
        removeImageIds: draft.removeImageIds,
        selection: draft.selection,
        onUploadProgress: tracksUpload
          ? (fraction) => {
              if (mountedRef.current) dispatch({ type: "PROGRESS", percent: Math.min(99, Math.round(fraction * 100)) });
            }
          : undefined,
        signal: controller.signal,
        onCommitted: latest.mode === "create" ? commitEmpty : undefined
      });
      if (ok && latest.mode === "create") {
        commitEmpty(false);
        latestRef.current.onReturnFocus();
      } else if (!ok && controller.signal.aborted) {
        const landedAlready = landingRef.current?.controller === controller && landingRef.current.handedOff;
        if (!landedAlready) latestRef.current.onRestoreField(draft.held);
      }
    } catch (cause) {
      const landedAlready = landingRef.current?.controller === controller && landingRef.current.handedOff;
      // Stopped via stop(): the owner says so; the draft stays as it was.
      if (controller.signal.aborted && !landedAlready) {
        latestRef.current.onRestoreField(draft.held);
        return;
      }
      // The draft is still here to fix and try again.
      latestRef.current.onReturnFocus();
      const reported = latestRef.current.onError(cause);
      if (mountedRef.current && latest.mode === "edit") {
        failedInEdit = true;
        transition({ type: "FAIL", mode: "edit", text: reported.text, seq: reported.seq });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (landingRef.current?.controller === controller) landingRef.current = null;
      if (mountedRef.current) {
        setLandingCommitted(false);
        if (!failedInEdit) transition({ type: "SETTLE" });
      }
    }
  }

  /**
   * Single entry point for Send / Save (button or ⌘↩). An untouched edit
   * closes quietly like Esc; pressing while images are still preparing queues
   * into `preparing` until they land.
   */
  async function submit() {
    if (phaseRef.current === "landing" || phaseRef.current === "saving" || phaseRef.current === "preparing") return;
    const latest = latestRef.current;
    if (latest.mode === "edit" && !latest.dirty && !isLocked()) {
      latest.onCloseClean?.();
      return;
    }
    if (latest.ready && latest.compressing > 0) {
      transition({ type: "PREPARE" });
      latest.onQueued?.();
      return;
    }
    if (!latest.ready || latest.compressing > 0 || !latest.hasPayload) return;
    await runSubmit();
  }

  /**
   * The one stop() called by Esc, the Stop button, and touch. Returns true
   * when there was a queued or in-flight submission to halt.
   */
  function stop(): boolean {
    if (phaseRef.current === "preparing") {
      transition({ type: "STOP" });
      latestRef.current.onStoppedQueued?.();
      return true;
    }
    const controller = abortRef.current;
    if (controller && !controller.signal.aborted) {
      controller.abort();
      return true;
    }
    return false;
  }

  /** An image failed or was rejected while preparing: hold the queued send back. */
  function cancelQueued() {
    if (phaseRef.current === "preparing") transition({ type: "STOP" });
  }

  /** Clears an edit save failure once the user moves on. */
  function clearError() {
    if (phaseRef.current === "error") transition({ type: "CLEAR_ERROR" });
  }

  return {
    phase: state.phase,
    uploadPercent: state.uploadPercent,
    error: state.error,
    locked,
    isLocked,
    sending,
    isInFlight,
    spinnerShown,
    canSubmit,
    canQueue,
    showStopButton,
    canStop,
    landingHoldingTiles,
    landingRawContent,
    handoffLanding,
    submit,
    stop,
    cancelQueued,
    clearError
  };
}
