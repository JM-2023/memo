import { describe, expect, it } from "vitest";
import { applyTaskFlips, freshestTaskMemo } from "../src/lib/taskFlips";
import type { Memo } from "../src/lib/types";

function memo(seq: number, content: string): Memo {
  return {
    id: "memo-task",
    content,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    pinnedAt: null,
    deletedAt: null,
    seq,
    images: []
  };
}

describe("task flip batching", () => {
  it("applies a batch in click order while preserving unrelated content", () => {
    expect(
      applyTaskFlips("heading\n- [ ] alpha\n- [x] beta", [
        { lineKey: 1, checked: true },
        { lineKey: 2, checked: false }
      ])
    ).toBe("heading\n- [x] alpha\n- [ ] beta");
  });

  it("drops a stale line instead of guessing after a concurrent edit", () => {
    expect(applyTaskFlips("plain now\n- [ ] beta", [{ lineKey: 0, checked: true }])).toBe("plain now\n- [ ] beta");
  });

  it("keeps a just-returned newer server base ahead of render-stale state", () => {
    const returned = memo(8, "- [x] alpha");
    const staleRender = memo(7, "- [ ] alpha");
    const freshSync = memo(9, "- [x] alpha\nremote");

    expect(freshestTaskMemo(returned, staleRender)).toBe(returned);
    expect(freshestTaskMemo(returned, freshSync)).toBe(freshSync);
  });
});
