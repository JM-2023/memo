import { describe, expect, it } from "vitest";
import { contentKeyOf, DecryptionError, openContent, sealContent } from "../functions/api/_utils/crypto";
import type { AppEnv } from "../functions/api/_utils/types";

function envWith(key: string | undefined, encryptedSample: string | null): AppEnv {
  const statement = {
    first: async () => (encryptedSample === null ? null : { content: encryptedSample })
  };
  return {
    MEMO_ENC_KEY: key,
    DB: {
      prepare: () => statement
    } as unknown as D1Database
  };
}

describe("content encryption fail-closed checks", () => {
  it("rejects plaintext mode when encrypted rows already exist", async () => {
    const key = await contentKeyOf(envWith("11".repeat(32), null));
    expect(key).not.toBeNull();
    const ciphertext = await sealContent(key!, "secret");

    await expect(contentKeyOf(envWith(undefined, ciphertext))).rejects.toBeInstanceOf(DecryptionError);
  });

  it("rejects a well-formed but incorrect deployment key", async () => {
    const sourceKey = await contentKeyOf(envWith("33".repeat(32), null));
    const ciphertext = await sealContent(sourceKey!, "secret");

    await expect(contentKeyOf(envWith("44".repeat(32), ciphertext))).rejects.toBeInstanceOf(DecryptionError);
  });

  it("rejects malformed key configuration before a write", async () => {
    await expect(contentKeyOf(envWith("not-hex", null))).rejects.toBeInstanceOf(DecryptionError);
  });

  it("keeps a literal enc1 prefix when metadata says the row is plaintext", async () => {
    await expect(openContent(null, "enc1:hello world", "plain")).resolves.toBe("enc1:hello world");
  });
});
