import { describe, expect, it } from "vitest";
import { modelRuntimeProgressFromTransformerEvent } from "../src/lib/modelRuntime";

describe("model runtime progress", () => {
  it("maps aggregate model bytes into the loading phase", () => {
    expect(
      modelRuntimeProgressFromTransformerEvent({
        status: "progress_total",
        progress: 50,
        loaded: 60,
        total: 120
      })
    ).toEqual({ stage: "loading-files", percent: 45, loadedBytes: 60, totalBytes: 120 });
  });

  it("advances to runtime startup only on the real pipeline-ready event", () => {
    expect(modelRuntimeProgressFromTransformerEvent({ status: "done" })).toBeNull();
    expect(modelRuntimeProgressFromTransformerEvent({ status: "ready" })).toEqual({
      stage: "starting-runtime",
      percent: 88
    });
  });
});
