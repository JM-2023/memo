import { describe, expect, it } from "vitest";
import {
  INITIAL_SUBMISSION,
  extractTypedDelta,
  isInFlightPhase,
  isLockedPhase,
  submissionReducer
} from "../src/hooks/useSubmission";

describe("submissionReducer", () => {
  it("runs create mode through idle → preparing → landing → idle", () => {
    const preparing = submissionReducer(INITIAL_SUBMISSION, { type: "PREPARE" });
    expect(preparing).toEqual({ phase: "preparing", uploadPercent: null, error: null });

    const landing = submissionReducer(preparing, { type: "START", mode: "create", tracksUpload: true });
    expect(landing).toEqual({ phase: "landing", uploadPercent: null, error: null });

    // Progress updates are ignored outside edit saving.
    expect(submissionReducer(landing, { type: "PROGRESS", percent: 50 })).toBe(landing);

    const settled = submissionReducer(landing, { type: "SETTLE" });
    expect(settled).toEqual(INITIAL_SUBMISSION);
  });

  it("cancels a queued send back to idle on STOP", () => {
    const preparing = submissionReducer(INITIAL_SUBMISSION, { type: "PREPARE" });
    expect(submissionReducer(preparing, { type: "STOP" })).toEqual(INITIAL_SUBMISSION);
    // STOP is a no-op outside preparing (in-flight requests stop via AbortController + SETTLE).
    const saving = submissionReducer(INITIAL_SUBMISSION, { type: "START", mode: "edit", tracksUpload: false });
    expect(submissionReducer(saving, { type: "STOP" })).toBe(saving);
  });

  it("runs edit mode through idle → saving → error → idle/retry", () => {
    const saving = submissionReducer(INITIAL_SUBMISSION, { type: "START", mode: "edit", tracksUpload: true });
    expect(saving).toEqual({ phase: "saving", uploadPercent: 0, error: null });

    const halfway = submissionReducer(saving, { type: "PROGRESS", percent: 42 });
    expect(halfway).toEqual({ phase: "saving", uploadPercent: 42, error: null });

    const failed = submissionReducer(halfway, { type: "FAIL", mode: "edit", text: "Network error", seq: 3 });
    expect(failed).toEqual({ phase: "error", uploadPercent: null, error: { text: "Network error", seq: 3 } });

    // Retrying from error enters saving directly and clears the previous error.
    const retry = submissionReducer(failed, { type: "START", mode: "edit", tracksUpload: false });
    expect(retry).toEqual({ phase: "saving", uploadPercent: null, error: null });

    // Editing text clears error back to idle.
    expect(submissionReducer(failed, { type: "CLEAR_ERROR" })).toEqual(INITIAL_SUBMISSION);
  });

  it("never enters an error phase in create mode", () => {
    const landing = submissionReducer(INITIAL_SUBMISSION, { type: "START", mode: "create", tracksUpload: false });
    expect(submissionReducer(landing, { type: "FAIL", mode: "create", text: "Unexpected", seq: 1 })).toEqual(INITIAL_SUBMISSION);
  });
});

describe("submission lock selectors", () => {
  it("locks during busy, preparing, and saving, but keeps create landing editable", () => {
    expect(isLockedPhase("idle", false)).toBe(false);
    expect(isLockedPhase("landing", false)).toBe(false);
    expect(isLockedPhase("error", false)).toBe(false);
    expect(isLockedPhase("preparing", false)).toBe(true);
    expect(isLockedPhase("saving", false)).toBe(true);
    expect(isLockedPhase("idle", true)).toBe(true);
  });

  it("reports in-flight phases consistently", () => {
    expect(isInFlightPhase("idle")).toBe(false);
    expect(isInFlightPhase("error")).toBe(false);
    expect(isInFlightPhase("preparing")).toBe(true);
    expect(isInFlightPhase("landing")).toBe(true);
    expect(isInFlightPhase("saving")).toBe(true);
  });
});

describe("extractTypedDelta", () => {
  it("extracts newly typed characters at the end, start, or middle of sent text", () => {
    expect(extractTypedDelta("First memo", "First memoN")).toBe("N");
    expect(extractTypedDelta("First memo", "NFirst memo")).toBe("N");
    expect(extractTypedDelta("First memo", "FirstN memo")).toBe("N");
    expect(extractTypedDelta("First memo", "First memoo")).toBe("o");
    expect(extractTypedDelta("First memo", "FFirst memo")).toBe("F");
  });

  it("handles deletions, full replacements, emoji surrogate pairs, and CJK text", () => {
    expect(extractTypedDelta("First memo", "First mem")).toBe("");
    expect(extractTypedDelta("First memo", "Brand new")).toBe("Brand new");
    expect(extractTypedDelta("a😀b", "a😀🎉b")).toBe("🎉");
    expect(extractTypedDelta("第一条", "第一条你好")).toBe("你好");
    expect(extractTypedDelta("a", "a", "a")).toBe("a");
  });
});
