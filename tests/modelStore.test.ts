import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  listStoredModelFiles,
  purgeOtherModelVersions,
  readStoredModelFile,
  writeStoredModelFile
} from "../src/lib/modelStore";

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe("model store", () => {
  it("round-trips bytes per version and request path", async () => {
    await writeStoredModelFile("v-round", "onnx/model.onnx", bytesOf("weights"));
    const stored = await readStoredModelFile("v-round", "onnx/model.onnx");
    expect(stored).not.toBeNull();
    expect(new TextDecoder().decode(stored!)).toBe("weights");
    expect(await readStoredModelFile("v-round", "missing.json")).toBeNull();
    expect(await readStoredModelFile("v-other", "onnx/model.onnx")).toBeNull();
  });

  it("lists the request paths present for one version only", async () => {
    await writeStoredModelFile("v-list", "config.json", bytesOf("a"));
    await writeStoredModelFile("v-list", "onnx/model.onnx", bytesOf("b"));
    await writeStoredModelFile("v-noise", "config.json", bytesOf("c"));
    const present = await listStoredModelFiles("v-list");
    expect(present).toEqual(new Set(["config.json", "onnx/model.onnx"]));
  });

  it("purges every other version and keeps the active one", async () => {
    await writeStoredModelFile("v-old", "config.json", bytesOf("old"));
    await writeStoredModelFile("v-new", "config.json", bytesOf("new"));
    await purgeOtherModelVersions("v-new");
    expect(await readStoredModelFile("v-old", "config.json")).toBeNull();
    const kept = await readStoredModelFile("v-new", "config.json");
    expect(kept && new TextDecoder().decode(kept)).toBe("new");
  });
});
