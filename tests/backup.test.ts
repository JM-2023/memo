import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, exportData, importDataInChunks, isTransientImportFailure, type BackupItem, type BackupMemo } from "../src/lib/api";
import { BackupFormatError, BackupScanner, inspectBackup, readBackupItems } from "../src/lib/backupFile";

afterEach(() => {
  vi.unstubAllGlobals();
});

function memo(id: string, overrides: Partial<BackupMemo> = {}): BackupMemo {
  return {
    id,
    content: `memo ${id}`,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    pinnedAt: null,
    deletedAt: null,
    images: [],
    ...overrides
  };
}

/** Feed `text` to a scanner in runs of `size` chars, collecting parsed elements. */
function scan(text: string, size: number) {
  const scanner = new BackupScanner();
  const items: { kind: string; value: unknown }[] = [];
  for (let offset = 0; offset < text.length; offset += size) {
    for (const element of scanner.push(text.slice(offset, offset + size))) items.push({ kind: element.kind, value: JSON.parse(element.json) });
  }
  scanner.finish();
  return items;
}

describe("backup file reader", () => {
  const tricky = {
    // Escapes, brackets and commas inside strings, nested values, and a
    // header that sits after the arrays.
    memos: [
      memo("a", { content: 'quote " backslash \\ ] } , [ { "' }),
      memo("b", { content: "line\nbreak \\\" end\\\\", images: [{ id: "i", mime: "image/png", width: 1, height: 1, dataBase64: "AQ==" }] }),
      memo("c", { content: "中文 😀 \u0001" })
    ],
    nested: { memos: [{ id: "not-a-memo" }], list: [[1, 2], { x: "]" }] },
    tags: [{ path: "work/项目", pinnedAt: "2026-07-16T00:00:00.000Z" }],
    hasMore: false,
    format: "memo-backup",
    version: 1
  };

  it("reads every element at any chunk boundary, in any key order", () => {
    const text = JSON.stringify(tricky, null, 1);
    const expected = [
      ...tricky.memos.map((value) => ({ kind: "memo", value })),
      ...tricky.tags.map((value) => ({ kind: "tag", value }))
    ];
    for (const size of [1, 2, 3, 7, 64, text.length]) expect(scan(text, size)).toEqual(expected);
  });

  it("matches JSON.parse on the shipped demo notebook", async () => {
    const text = readFileSync(new URL("../docs/demo/notebook.json", import.meta.url), "utf8");
    const parsed = JSON.parse(text) as { memos: BackupMemo[]; tags: unknown[] };
    const items: BackupItem[] = [];
    for await (const item of readBackupItems(new Blob([text]))) items.push(item);
    expect(items.filter((item) => item.kind === "memo").map((item) => (item.kind === "memo" ? item.memo : null))).toEqual(parsed.memos);
    expect(items.filter((item) => item.kind === "tag").map((item) => (item.kind === "tag" ? item.tag : null))).toEqual(parsed.tags);
    await expect(inspectBackup(new Blob([text]))).resolves.toEqual({
      memoCount: parsed.memos.length,
      imageCount: parsed.memos.reduce((sum, item) => sum + item.images.length, 0)
    });
  });

  it("rejects files that are not a complete backup-v1 object", async () => {
    const cases = [
      "not json",
      "[]",
      JSON.stringify({ format: "memo-backup", version: 2, memos: [] }),
      JSON.stringify({ format: "other", version: 1, memos: [] }),
      JSON.stringify({ format: "memo-backup", version: 1 }),
      JSON.stringify({ format: "memo-backup", version: 1, memos: [] }).slice(0, -1),
      `${JSON.stringify({ format: "memo-backup", version: 1, memos: [] })} {}`,
      JSON.stringify({ format: "memo-backup", version: 1, memos: [1] })
    ];
    for (const text of cases) await expect(inspectBackup(new Blob([text]))).rejects.toBeInstanceOf(BackupFormatError);
  });
});

function importFetch(results: (body: { memos: BackupMemo[]; tags: unknown[] }) => unknown = (body) => ({ imported: body.memos.length, skipped: 0, images: 0 })) {
  const bodies: { memos: BackupMemo[]; tags: unknown[] }[] = [];
  const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { format: string; version: number; memos: BackupMemo[]; tags: unknown[] };
    expect(body).toMatchObject({ format: "memo-backup", version: 1 });
    bodies.push(body);
    return new Response(JSON.stringify(results(body)), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return bodies;
}

describe("chunked import", () => {
  it("packs text memos a hundred to a request and reports progress", async () => {
    const bodies = importFetch((body) => ({ imported: body.memos.length - 1, skipped: 1, images: 0 }));
    const items: BackupItem[] = Array.from({ length: 250 }, (_, index) => ({ kind: "memo", memo: memo(`m${index}`) }));
    items.push({ kind: "tag", tag: { path: "work", pinnedAt: "2026-07-16T00:00:00.000Z" } });
    const progress = vi.fn();

    await expect(importDataInChunks(items, { onProgress: progress })).resolves.toEqual({ imported: 247, skipped: 3, images: 0 });
    expect(bodies.map((body) => [body.memos.length, body.tags.length])).toEqual([
      [100, 0],
      [100, 0],
      [50, 1]
    ]);
    expect(progress.mock.calls.map(([value]) => value.done)).toEqual([100, 200, 250]);
  });

  it("budgets one statement per memo with images and bounds text and image weight", async () => {
    const bodies = importFetch();
    const image = { id: "x", mime: "image/png", width: 1, height: 1, dataBase64: "AQ==" };
    const withImages: BackupItem[] = Array.from({ length: 40 }, (_, index) => ({ kind: "memo", memo: memo(`i${index}`, { images: [{ ...image, id: `img${index}` }] }) }));
    await importDataInChunks(withImages);
    // 35 statements: three shared text statements + one per memo with images.
    expect(bodies.map((body) => body.memos.length)).toEqual([32, 8]);

    bodies.length = 0;
    const long: BackupItem[] = Array.from({ length: 5 }, (_, index) => ({ kind: "memo", memo: memo(`l${index}`, { content: "x".repeat(40_000) }) }));
    await importDataInChunks(long);
    expect(bodies.map((body) => body.memos.length)).toEqual([2, 2, 1]);

    bodies.length = 0;
    const heavy: BackupItem[] = Array.from({ length: 3 }, (_, index) => ({ kind: "memo", memo: memo(`h${index}`, { images: [{ ...image, id: `heavy${index}`, dataBase64: "A".repeat(100) }] }) }));
    await importDataInChunks(heavy, { maxBase64Chars: 250 });
    expect(bodies.map((body) => body.memos.length)).toEqual([2, 1]);
  });

  it("stops between chunks once aborted, keeping the totals of what was sent", async () => {
    const controller = new AbortController();
    const bodies = importFetch();
    const items: BackupItem[] = Array.from({ length: 300 }, (_, index) => ({ kind: "memo", memo: memo(`s${index}`) }));
    const progress = vi.fn(() => controller.abort());

    await expect(importDataInChunks(items, { signal: controller.signal, onProgress: progress })).rejects.toMatchObject({ name: "AbortError" });
    expect(bodies).toHaveLength(1);
    expect(progress).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for an empty backup", async () => {
    const bodies = importFetch();
    await expect(importDataInChunks([])).resolves.toEqual({ imported: 0, skipped: 0, images: 0 });
    expect(bodies).toHaveLength(0);
  });
});

describe("paged export", () => {
  function exportFetch(pages: { body: string; headers: Record<string, string> }[]) {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        urls.push(String(input));
        const page = pages[urls.length - 1];
        return new Response(page.body, { status: 200, headers: page.headers });
      })
    );
    return urls;
  }

  it("joins page bodies verbatim and counts progress from headers", async () => {
    const urls = exportFetch([
      { body: '{"format":"memo-backup","version":1,"exportedAt":"t","tags":[],"memos":[{"id":"a"}', headers: { "X-Export-Count": "1", "X-Export-Total": "2", "X-Export-Next": "c1" } },
      { body: ',{"id":"b"}]}', headers: { "X-Export-Count": "1" } }
    ]);
    const progress = vi.fn();

    const blob = await exportData({ onProgress: progress });
    expect(urls).toEqual(["/api/export?parts=1", "/api/export?parts=1&after=c1"]);
    expect(JSON.parse(await blob.text())).toEqual({ format: "memo-backup", version: 1, exportedAt: "t", tags: [], memos: [{ id: "a" }, { id: "b" }] });
    expect(blob.type).toBe("application/json");
    expect(progress.mock.calls.map(([value]) => value)).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 }
    ]);
  });

  it("refuses a legacy page from a server that ignored parts mode instead of saving it truncated", async () => {
    exportFetch([
      {
        body: '{"format":"memo-backup","version":1,"exportedAt":"t","memos":[{"id":"a"}],"tags":[],"hasMore":true,"nextAfter":"c1"}',
        headers: { "Content-Type": "application/json" }
      }
    ]);
    await expect(exportData()).rejects.toMatchObject({ name: "ApiError", code: "EXPORT_FORMAT_UNSUPPORTED" });

    exportFetch([{ body: "{", headers: { "X-Export-Count": "many" } }]);
    await expect(exportData()).rejects.toMatchObject({ code: "EXPORT_FORMAT_UNSUPPORTED" });
  });

  it("refuses a cursor that does not advance and honours a stop", async () => {
    exportFetch([
      { body: "{", headers: { "X-Export-Count": "0", "X-Export-Total": "1", "X-Export-Next": "same" } },
      { body: "", headers: { "X-Export-Count": "0", "X-Export-Next": "same" } }
    ]);
    await expect(exportData()).rejects.toThrow("did not advance");

    const controller = new AbortController();
    exportFetch([{ body: "{", headers: { "X-Export-Count": "0", "X-Export-Total": "1", "X-Export-Next": "next" } }]);
    await expect(exportData({ signal: controller.signal, onProgress: () => controller.abort() })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("import failure kinds", () => {
  it("treats network, timeout, rate-limit and server failures as worth a rerun, and chunk rejections as not", () => {
    expect(isTransientImportFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientImportFailure(new ApiError("NETWORK_ERROR", 0, "unreachable"))).toBe(true);
    expect(isTransientImportFailure(new ApiError("REQUEST_TIMEOUT", 408, "slow"))).toBe(true);
    expect(isTransientImportFailure(new ApiError("REQUEST_FAILED", 429, "busy"))).toBe(true);
    expect(isTransientImportFailure(new ApiError("REQUEST_FAILED", 502, "Request failed (502)"))).toBe(true);
    expect(isTransientImportFailure(new ApiError("INTERNAL_ERROR", 500, "boom"))).toBe(true);

    expect(isTransientImportFailure(new ApiError("BACKUP_MEMO_INVALID", 400, "bad memo"))).toBe(false);
    expect(isTransientImportFailure(new ApiError("BACKUP_IMAGE_INVALID", 409, "taken"))).toBe(false);
    expect(isTransientImportFailure(new ApiError("MEMO_CONTENT_TOO_LONG", 400, "long"))).toBe(false);
    expect(isTransientImportFailure(new BackupFormatError())).toBe(false);
  });

  it("counts a connection dropped mid-import as worth a rerun", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const failure = await importDataInChunks([{ kind: "memo", memo: memo("n1") }]).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ code: "NETWORK_ERROR", status: 0 });
    expect(isTransientImportFailure(failure)).toBe(true);
  });
});
