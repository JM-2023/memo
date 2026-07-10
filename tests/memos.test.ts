import { describe, expect, it } from "vitest";
import { validateImages } from "../functions/api/memos/index";

describe("memo image validation", () => {
  it("rejects malformed base64 before it reaches D1", () => {
    const result = validateImages([
      { id: "image-1", dataBase64: "not/base64!", mime: "image/webp", width: 10, height: 10 }
    ]);

    expect(result.error?.code).toBe("INVALID_REQUEST_BODY");
    expect(result.images).toEqual([]);
  });

  it("accepts a bounded valid payload", () => {
    const result = validateImages([
      { id: "image-1", dataBase64: "AQIDBA==", mime: "image/webp", width: 10, height: 10 }
    ]);

    expect(result.error).toBeNull();
    expect(result.images).toHaveLength(1);
  });
});
