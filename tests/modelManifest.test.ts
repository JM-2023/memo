import { describe, expect, it } from "vitest";
import {
  MODEL_MANIFEST,
  MODEL_RELEASE_REPO,
  modelFileForCacheKey,
  modelMirrorUrls,
  modelTotalBytes,
  sha256Hex,
  verifyModelBytes,
  type ModelFileSpec
} from "../src/lib/modelManifest";

const encoder = new TextEncoder();

async function specFor(content: string): Promise<ModelFileSpec> {
  const bytes = encoder.encode(content);
  return { asset: "probe.bin", requestPath: "probe.bin", bytes: bytes.byteLength, sha256: await sha256Hex(bytes) };
}

describe("model manifest", () => {
  it("pins every file with a size and a SHA-256", () => {
    expect(MODEL_MANIFEST.files.length).toBe(4);
    expect(MODEL_MANIFEST.hfRevision).toMatch(/^[0-9a-f]{40}$/);
    for (const file of MODEL_MANIFEST.files) {
      expect(file.bytes).toBeGreaterThan(0);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.asset).not.toContain("/");
    }
    expect(modelTotalBytes()).toBe(MODEL_MANIFEST.files.reduce((sum, file) => sum + file.bytes, 0));
  });

  it("orders the CORS-capable pinned Hugging Face mirror before the release archive", () => {
    const onnx = MODEL_MANIFEST.files.find((file) => file.requestPath === "onnx/model_quantized.onnx")!;
    const urls = modelMirrorUrls(onnx);
    expect(urls[0]).toBe(
      `https://huggingface.co/${MODEL_MANIFEST.id}/resolve/${MODEL_MANIFEST.hfRevision}/onnx/model_quantized.onnx`
    );
    expect(urls[1]).toBe(
      `https://github.com/${MODEL_RELEASE_REPO}/releases/download/${MODEL_MANIFEST.releaseTag}/model_quantized.onnx`
    );
  });

  it("resolves cache keys by boundary-anchored request-path suffix", () => {
    const localKey = "/assets/model-cache-miss/Xenova/bge-small-zh-v1.5/onnx/model_quantized.onnx";
    expect(modelFileForCacheKey(localKey)?.requestPath).toBe("onnx/model_quantized.onnx");

    const remoteKey = "https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/config.json";
    expect(modelFileForCacheKey(remoteKey)?.requestPath).toBe("config.json");

    expect(modelFileForCacheKey("config.json")?.requestPath).toBe("config.json");
    expect(modelFileForCacheKey("https://example.test/models/generation_config.json")).toBeNull();
    expect(modelFileForCacheKey("wholly-unknown.bin")).toBeNull();
  });

  it("never lets config.json claim tokenizer_config.json", () => {
    const key = "/assets/model-cache-miss/Xenova/bge-small-zh-v1.5/tokenizer_config.json";
    expect(modelFileForCacheKey(key)?.requestPath).toBe("tokenizer_config.json");
  });

  it("verifies bytes by exact size and hash", async () => {
    const spec = await specFor("hello");
    expect(await verifyModelBytes(spec, encoder.encode("hello").buffer as ArrayBuffer)).toBe(true);
    expect(await verifyModelBytes(spec, encoder.encode("hell!").buffer as ArrayBuffer)).toBe(false);
    expect(await verifyModelBytes(spec, encoder.encode("hello!").buffer as ArrayBuffer)).toBe(false);
  });
});
