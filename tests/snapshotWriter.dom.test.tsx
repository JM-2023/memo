// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSnapshotWriterLease } from "../src/lib/snapshotWriter";

/** A minimal exclusive Web Locks manager: one holder per name, FIFO waiters. */
function fakeLocks() {
  const holders = new Map<string, boolean>();
  const queues = new Map<string, (() => void)[]>();
  const grant = (name: string) => {
    if (holders.get(name)) return;
    const next = queues.get(name)?.shift();
    if (next) next();
  };
  return {
    request(name: string, options: { signal?: AbortSignal }, callback: (lock: unknown) => unknown): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const run = () => {
          holders.set(name, true);
          Promise.resolve(callback({ name }))
            .then(resolve, reject)
            .finally(() => {
              holders.set(name, false);
              grant(name);
            });
        };
        const queue = queues.get(name) ?? [];
        queues.set(name, queue);
        options.signal?.addEventListener("abort", () => {
          const index = queue.indexOf(run);
          if (index >= 0) {
            queue.splice(index, 1);
            reject(new DOMException("Aborted", "AbortError"));
          }
        });
        queue.push(run);
        grant(name);
      });
    }
  };
}

const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");

afterEach(() => {
  if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
  else delete (navigator as Navigator & { locks?: unknown }).locks;
});

describe("snapshot writer lease", () => {
  it("lets exactly one tab write and hands over when it leaves", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: fakeLocks() });
    const first = renderHook(({ enabled }) => useSnapshotWriterLease(enabled), { initialProps: { enabled: true } });
    const second = renderHook(({ enabled }) => useSnapshotWriterLease(enabled), { initialProps: { enabled: true } });

    await waitFor(() => expect(first.result.current).toBe(true));
    expect(second.result.current).toBe(false);

    // Logging out (or a cold load still in progress) disables the lease.
    first.rerender({ enabled: false });
    await waitFor(() => expect(second.result.current).toBe(true));
    expect(first.result.current).toBe(false);

    first.rerender({ enabled: true });
    await act(async () => undefined);
    expect(first.result.current).toBe(false);
    second.unmount();
    await waitFor(() => expect(first.result.current).toBe(true));
    first.unmount();
  });

  it("writes in every tab where Web Locks are unavailable", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    const { result, rerender } = renderHook(({ enabled }) => useSnapshotWriterLease(enabled), { initialProps: { enabled: true } });
    await waitFor(() => expect(result.current).toBe(true));
    rerender({ enabled: false });
    expect(result.current).toBe(false);
  });
});
