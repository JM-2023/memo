import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, AuthRequiredError } from "../src/lib/api";
import { BUSY_HOLD_MS } from "../src/lib/motion";
import { optimisticMemo, SEND_UNDO_MS, sendStatesOf, type Outbox, type OutboxEntry, type SendState } from "../src/lib/outbox";
import { OutboxQueue, type OutboxDeps, type OutboxVoice } from "../src/lib/outboxQueue";
import type { Memo, NewImagePayload } from "../src/lib/types";

function picture(id: string): NewImagePayload {
  return { id, dataBase64: "AAAA", mime: "image/webp", width: 40, height: 30, previewUrl: `blob:${id}` };
}

/** A send written `second` seconds into the morning: the queue keeps them in that order. */
function entry(id: string, second: number, content = `${id} text`, images: NewImagePayload[] = []): OutboxEntry {
  return {
    id,
    memo: optimisticMemo(id, content, images, new Date(Date.UTC(2026, 10, 18, 9, 0, second))),
    content,
    draft: content,
    tag: null,
    images,
    selection: { start: content.length, end: content.length },
    status: "sending",
    failure: null
  };
}

/** The memo as the server stores it. */
function storedMemo(id: string, content: string, seq = 2, images: NewImagePayload[] = []): Memo {
  return { ...optimisticMemo(id, content, images, new Date(Date.UTC(2026, 10, 18, 9, 5))), seq };
}

const unreachable = () => new ApiError("NETWORK_ERROR", 0, "The server could not be reached. Check your connection and try again.");
const struggling = () => new ApiError("INTERNAL_ERROR", 503, "The server is having trouble.");

/** Enough turns of the microtask queue for a run of sends to settle. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}

interface HeldRequest {
  id: string;
  content: string;
  signal: AbortSignal;
  resolve(result: { memo: Memo; idempotent?: boolean }): void;
  reject(cause: unknown): void;
}

type Reply = { memo: Memo; idempotent?: boolean } | Error | "hold";

/**
 * The queue with everything App would hand it, faked: a server that answers
 * as `reply` says (or holds the request for the test), a notebook, a session
 * and a voice that records what it was asked to say.
 */
function harness(overrides: Partial<OutboxDeps> = {}) {
  const state = { signedIn: true, changingPasscode: false, leaving: false, online: true, visible: true, epoch: 0, passcodeChanges: 0, composerFree: true };
  const notebook = new Map<string, Memo>();
  const held: HeldRequest[] = [];
  const server = { reply: (id: string, content: string): Reply => ({ memo: storedMemo(id, content) }) };
  const create = vi.fn((id: string, content: string, _images: NewImagePayload[], options: { signal: AbortSignal }) => {
    const reply = server.reply(id, content);
    if (reply === "hold") {
      return new Promise<{ memo: Memo; idempotent?: boolean }>((resolve, reject) => {
        held.push({ id, content, signal: options.signal, resolve, reject });
        options.signal.addEventListener("abort", () => reject(new DOMException("The send was stopped.", "AbortError")));
      });
    }
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  });
  const update = vi.fn(async (id: string, changes: { expectedSeq: number; content: string }) => ({
    memo: { ...storedMemo(id, changes.content), seq: changes.expectedSeq + 1 }
  }));
  const voice = {
    sending: vi.fn((_id: string) => 41),
    failedHidden: vi.fn((_id: string, toast: number, _state: SendState) => toast || 42),
    sent: vi.fn((_saved: Memo, said: { toast: number } | undefined, _leaves: boolean) => said?.toast || 0),
    retrying: vi.fn(),
    offline: vi.fn(),
    refused: vi.fn(),
    purged: vi.fn(),
    composerBusy: vi.fn(),
    tookBack: vi.fn(),
    discarded: vi.fn()
  } satisfies OutboxVoice;
  /** What the image cache was told: holds taken and let go, previews revoked. */
  const images = { held: [] as string[], released: [] as string[], revoked: [] as string[] };
  const refocus = vi.fn();
  const deps = {
    create,
    update,
    signedIn: () => state.signedIn,
    changingPasscode: () => state.changingPasscode,
    leaving: () => state.leaving,
    session: () => ({ epoch: state.epoch, passcodeChanges: state.passcodeChanges }),
    // As App does: a new session epoch, and the gate.
    dropToLogin: vi.fn(() => {
      state.epoch += 1;
      state.signedIn = false;
    }),
    stored: (id: string) => notebook.get(id),
    store: vi.fn((saved: Memo) => void notebook.set(saved.id, saved)),
    storeRemote: vi.fn((saved: Memo) => void notebook.set(saved.id, saved)),
    sync: vi.fn(),
    notifyPeers: vi.fn(),
    shows: vi.fn((_memo: Memo) => true),
    move: vi.fn((_intent: string, _ids: Iterable<string>, apply: () => void) => apply()),
    holdFocus: vi.fn((_id: string) => refocus),
    recall: vi.fn((_entry: OutboxEntry) => state.composerFree),
    busy: vi.fn((_id: string) => false),
    trashUndone: vi.fn(),
    trashReturned: vi.fn(),
    voice,
    online: () => state.online,
    visible: () => state.visible,
    holdImages: vi.fn((pictures: readonly NewImagePayload[]) => {
      const ids = pictures.map((image) => image.id);
      images.held.push(...ids);
      return () => void images.released.push(...ids);
    }),
    revoke: vi.fn((url: string) => void images.revoked.push(url)),
    ...overrides
  } satisfies OutboxDeps;
  const renders: Outbox[] = [];
  const queue = new OutboxQueue(deps, { onChange: (outbox) => renders.push(outbox), keepDiscarded: 3 });
  const ids = () => [...queue.entries.keys()];
  const states = () => Object.fromEntries(sendStatesOf(queue.entries, notebook, state.online));
  const sentIds = () => create.mock.calls.map((call) => call[0]);
  return { queue, deps, voice, state, notebook, held, server, create, update, images, refocus, renders, ids, states, sentIds };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the send queue offline", () => {
  it("holds what is written offline and delivers it in the order it was written once the link is back", async () => {
    const h = harness();
    h.state.online = false;
    h.server.reply = () => unreachable();
    for (const [id, second] of [["a", 1], ["b", 2], ["c", 3]] as const) {
      await h.queue.send(entry(id, second));
      await flush();
    }

    // Each press tried the oldest one waiting, met the same dead link and
    // stopped there: nothing behind it went out to fail the same way.
    expect(h.sentIds()).toEqual(["a", "a", "a"]);
    expect(h.ids()).toEqual(["a", "b", "c"]);
    expect(h.states()).toEqual({ a: "failed", b: "failed", c: "failed" });
    expect([...h.queue.entries.values()].map((item) => item.failure)).toEqual(["network", "network", "network"]);
    expect(h.voice.offline).toHaveBeenCalledTimes(3);
    expect(h.voice.retrying).not.toHaveBeenCalled();
    expect(h.voice.refused).not.toHaveBeenCalled();

    // The browser comes back online: the queue's own watch sends them.
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    const unhook = h.queue.listen();
    h.state.online = true;
    h.server.reply = (id, content) => ({ memo: storedMemo(id, content) });
    h.create.mockClear();
    window.dispatchEvent(new Event("online"));
    await flush();
    unhook();

    // Oldest first, one at a time, under the ids they were written with.
    expect(h.sentIds()).toEqual(["a", "b", "c"]);
    expect(h.deps.store.mock.calls.map(([saved]) => saved.id)).toEqual(["a", "b", "c"]);
    expect(h.queue.entries.size).toBe(0);
    expect(h.voice.sent).toHaveBeenCalledTimes(3);
    // Each card took its memo's place in one change of the feed.
    expect(h.deps.move.mock.calls.map(([intent]) => intent)).toEqual(["edit-save", "edit-save", "edit-save"]);
    expect(h.deps.sync).toHaveBeenCalledTimes(3);
    expect(h.deps.notifyPeers).toHaveBeenCalledTimes(3);
  });

  it("sends nothing on a clock or a wake while offline, and nothing when the page is out of sight", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.server.reply = () => struggling();
    await h.queue.send(entry("a", 1));
    await flush();
    expect(h.states()).toEqual({ a: "retrying" });

    // Out of sight when its clock runs out: it waits for the page.
    h.state.visible = false;
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(h.create).toHaveBeenCalledTimes(1);
    h.queue.resume("wake");
    expect(h.create).toHaveBeenCalledTimes(1);

    // Back in view: the wake sends what the clock held.
    h.state.visible = true;
    h.server.reply = (id, content) => ({ memo: storedMemo(id, content) });
    h.queue.resume("wake");
    await flush();
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.queue.entries.size).toBe(0);
  });
});

describe("a memo deleted on another device mid-send", () => {
  it("lets go of a send stored once and deleted for good since, and sends the one behind it", async () => {
    const h = harness();
    h.server.reply = (id, content) => (id === "gone" ? "hold" : { memo: storedMemo(id, content) });
    await h.queue.send(entry("gone", 1, "gone text", [picture("img-gone")]));
    await h.queue.send(entry("next", 2));
    await flush();
    // One request at a time: the one behind waits for the first.
    expect(h.sentIds()).toEqual(["gone"]);

    h.held[0].reject(new ApiError("MEMO_ID_RETIRED", 409, "This memo was deleted permanently."));
    await flush();

    expect(h.voice.purged).toHaveBeenCalledTimes(1);
    expect(h.voice.refused).not.toHaveBeenCalled();
    expect(h.deps.move.mock.calls[0].slice(0, 2)).toEqual(["purge", ["gone"]]);
    expect(h.notebook.has("gone")).toBe(false);
    // Its pictures leave the cache hold; nothing is retried.
    expect(h.images.released).toContain("img-gone");
    expect(h.sentIds()).toEqual(["gone", "next"]);
    expect(h.ids()).toEqual([]);
    expect(h.notebook.has("next")).toBe(true);
  });

  it("lands the server's version when the memo got through, its answer was lost, and it was trashed elsewhere", async () => {
    const h = harness();
    const trashed = { ...storedMemo("a", "a text", 5), deletedAt: "2026-11-18T09:06:00.000Z" };
    h.server.reply = () => new ApiError("VERSION_CONFLICT", 409, "Changed elsewhere", undefined, trashed);
    await h.queue.send(entry("a", 1));
    await flush();

    expect(h.deps.store).toHaveBeenCalledWith(trashed);
    expect(h.voice.sent).toHaveBeenCalledWith(trashed, undefined, false);
    expect(h.queue.entries.size).toBe(0);
    expect(h.voice.refused).not.toHaveBeenCalled();
  });

  it("counts a send as sent when sync brought its memo in while the request failed", async () => {
    const h = harness();
    h.server.reply = () => "hold";
    await h.queue.send(entry("a", 1));
    await flush();
    const synced = storedMemo("a", "a text", 3);
    h.notebook.set("a", synced);
    h.held[0].reject(struggling());
    await flush();

    expect(h.voice.sent).toHaveBeenCalledWith(synced, undefined, false);
    expect(h.queue.entries.size).toBe(0);
    expect(h.voice.retrying).not.toHaveBeenCalled();
  });

  it("brings a send a tag rename rewrote on its way level with a version-checked update", async () => {
    const h = harness();
    h.server.reply = () => "hold";
    await h.queue.send(entry("a", 1, "plan #work"));
    await flush();
    h.queue.retag("work", "job", h.queue.retagScope());
    expect(h.queue.get("a")?.content).toBe("plan #job");
    expect(h.queue.get("a")?.memo.content).toBe("plan #job");

    h.held[0].resolve({ memo: storedMemo("a", "plan #work", 4) });
    await flush();
    expect(h.update).toHaveBeenCalledWith("a", { expectedSeq: 4, content: "plan #job", addImages: [], removeImageIds: [] }, expect.anything());
    expect(h.notebook.get("a")?.content).toBe("plan #job");
  });
});

describe("the session lost mid-queue", () => {
  it("stops the queue on a lost session, keeps every send, and delivers them in order after the next sign-in", async () => {
    const h = harness();
    h.server.reply = () => "hold";
    await h.queue.send(entry("a", 1));
    await h.queue.send(entry("b", 2));
    await flush();
    expect(h.sentIds()).toEqual(["a"]);

    h.held[0].reject(new AuthRequiredError());
    await flush();

    expect(h.deps.dropToLogin).toHaveBeenCalledTimes(1);
    expect(h.ids()).toEqual(["a", "b"]);
    expect([...h.queue.entries.values()].map((item) => [item.status, item.failure])).toEqual([
      ["failed", "auth"],
      ["failed", "auth"]
    ]);
    // The gate says its own words; the queue says nothing over them.
    expect(h.voice.offline).not.toHaveBeenCalled();
    expect(h.voice.refused).not.toHaveBeenCalled();
    expect(h.voice.retrying).not.toHaveBeenCalled();

    // Signed out, nothing goes: not the link, not a press.
    h.queue.resume("link");
    h.queue.resume("reader", "a");
    await flush();
    expect(h.create).toHaveBeenCalledTimes(1);

    // The next sign-in is the link coming back.
    h.state.signedIn = true;
    h.server.reply = (id, content) => ({ memo: storedMemo(id, content) });
    h.queue.resume("link");
    await flush();
    expect(h.sentIds()).toEqual(["a", "a", "b"]);
    expect(h.deps.store.mock.calls.map(([saved]) => saved.id)).toEqual(["a", "b"]);
    expect(h.queue.entries.size).toBe(0);
  });

  it("leaves an answer that comes back across a change of session to the next notebook", async () => {
    const h = harness();
    h.server.reply = () => "hold";
    await h.queue.send(entry("a", 1));
    await flush();
    // Expired elsewhere and signed in again before the answer came.
    h.state.epoch += 2;

    h.held[0].resolve({ memo: storedMemo("a", "a text") });
    await flush();
    expect(h.queue.entries.size).toBe(0);
    expect(h.deps.store).not.toHaveBeenCalled();
    expect(h.voice.sent).not.toHaveBeenCalled();
  });

  it("treats a passcode change as the same session: an answer across it lands, a refusal under the old cookie waits it out", async () => {
    const h = harness();
    h.server.reply = () => "hold";
    await h.queue.send(entry("a", 1));
    await h.queue.send(entry("b", 2));
    await flush();
    // The passcode dialog opens: a new epoch, counted as a passcode change.
    h.state.epoch += 1;
    h.state.passcodeChanges += 1;
    h.state.changingPasscode = true;

    h.held[0].resolve({ memo: storedMemo("a", "a text") });
    await flush();
    expect(h.notebook.has("a")).toBe(true);
    // The queue waits while the cookie changes hands.
    expect(h.sentIds()).toEqual(["a"]);

    h.state.changingPasscode = false;
    h.queue.resume("link");
    await flush();
    expect(h.sentIds()).toEqual(["a", "b"]);
    // Turned away with the cookie the change replaced: no drop to the gate.
    h.state.epoch += 1;
    h.state.passcodeChanges += 1;
    h.held[1].reject(new AuthRequiredError());
    await flush();
    expect(h.deps.dropToLogin).not.toHaveBeenCalled();
    expect(h.queue.get("b")?.status).toBe("sending");
  });

  it("sends nothing while a logout is under way, and a logout discards every unsent memo", async () => {
    const h = harness();
    h.server.reply = () => "hold";
    await h.queue.send(entry("a", 1, "a text", [picture("img-a")]));
    await h.queue.send(entry("b", 2));
    await flush();
    h.state.leaving = true;
    h.queue.stopClocks();
    h.queue.resume("reader", "b");
    await flush();
    expect(h.create).toHaveBeenCalledTimes(1);

    h.queue.discardAll();
    expect(h.held[0].signal.aborted).toBe(true);
    expect(h.queue.entries.size).toBe(0);
    expect(h.images.released).toContain("img-a");
    expect(h.images.revoked).toContain("blob:img-a");
    await flush();
    // The stopped request says nothing.
    expect(h.voice.refused).not.toHaveBeenCalled();
    expect(h.voice.offline).not.toHaveBeenCalled();
  });
});

describe("retries", () => {
  it("retries a send the server keeps failing at 2 s, 6 s and 20 s, then once a minute, until it is refused for good", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.server.reply = () => struggling();
    await h.queue.send(entry("a", 1));
    await flush();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.states()).toEqual({ a: "retrying" });

    const tries = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      await flush();
      return h.create.mock.calls.length;
    };
    expect(await tries(1_999)).toBe(1);
    expect(await tries(1)).toBe(2);
    expect(await tries(5_999)).toBe(2);
    expect(await tries(1)).toBe(3);
    expect(await tries(19_999)).toBe(3);
    expect(await tries(1)).toBe(4);
    expect(await tries(59_999)).toBe(4);
    expect(await tries(1)).toBe(5);
    expect(await tries(60_000)).toBe(6);
    // Said once, when it first failed; the tries after it stay quiet.
    expect(h.voice.retrying).toHaveBeenCalledTimes(1);

    // Then the server refuses it: no clock tries it again, nor the link.
    const full = new ApiError("STORAGE_FULL", 507, "The database is full.");
    h.server.reply = () => full;
    expect(await tries(60_000)).toBe(7);
    expect(h.states()).toEqual({ a: "refused" });
    expect(h.voice.refused).toHaveBeenCalledWith(full);
    expect(await tries(10 * 60_000)).toBe(7);
    h.queue.resume("link");
    h.queue.resume("wake");
    await flush();
    expect(h.create).toHaveBeenCalledTimes(7);

    // Only a press on that card sends it again.
    h.server.reply = (id, content) => ({ memo: storedMemo(id, content) });
    h.queue.resume("reader", "a");
    await flush();
    expect(h.create).toHaveBeenCalledTimes(8);
    expect(h.queue.entries.size).toBe(0);
  });

  it("starts the quick retries over after a press, and lets the sends behind a failing one through", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.server.reply = (id, content) => (id === "stuck" ? struggling() : { memo: storedMemo(id, content) });
    await h.queue.send(entry("stuck", 1));
    await flush();
    await vi.advanceTimersByTimeAsync(2_000 + 6_000);
    await flush();
    expect(h.create).toHaveBeenCalledTimes(3);

    // A send behind it goes out on its own.
    await h.queue.send(entry("next", 2));
    await flush();
    expect(h.notebook.has("next")).toBe(true);
    // That press was also a fresh start for the stuck one: 2 s again, not 20 s.
    const before = h.create.mock.calls.filter(([id]) => id === "stuck").length;
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(h.create.mock.calls.filter(([id]) => id === "stuck").length).toBe(before + 1);
  });

  it("says a hidden card's failure in its toast, once per state, after waiting out the busy hold", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.deps.shows.mockReturnValue(false);
    h.server.reply = () => "hold";
    await h.queue.send(entry("a", 1), { hidden: true });
    // Inside the 150ms busy hold, no "Sending…" toast appears yet.
    expect(h.voice.sending).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(BUSY_HOLD_MS - 1);
    expect(h.voice.sending).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.voice.sending).toHaveBeenCalledWith("a");

    h.held[0].reject(struggling());
    await flush();
    expect(h.voice.failedHidden).toHaveBeenCalledWith("a", 41, "retrying");
    // Escalating from retrying to a permanent server refusal updates the same toast.
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    h.held[1].reject(new ApiError("STORAGE_FULL", 507, "The database is full."));
    await flush();
    expect(h.voice.failedHidden).toHaveBeenCalledWith("a", 41, "refused");
    // The toast speaks for the card: no second error on top.
    expect(h.voice.refused).not.toHaveBeenCalled();
  });

  it("never flashes a hidden Sending… toast when a fast send settles inside the busy hold", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.deps.shows.mockReturnValue(false);
    h.server.reply = () => "hold";
    await h.queue.send(entry("fast", 1), { hidden: true });
    expect(h.voice.sending).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(BUSY_HOLD_MS - 20);
    const saved = storedMemo("fast", "fast text");
    h.held[0].resolve({ memo: saved });
    await flush();
    await vi.advanceTimersByTimeAsync(BUSY_HOLD_MS * 2);
    expect(h.voice.sending).not.toHaveBeenCalled();
    expect(h.voice.sent).toHaveBeenCalledWith(saved, { toast: 0, failed: null }, false);
  });

  it("keeps automatic retries in retrying/failed state and only flips back to sending on a manual Retry press", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.server.reply = () => struggling();
    await h.queue.send(entry("a", 1));
    await flush();
    expect(h.states()).toEqual({ a: "retrying" });

    // Timer auto-retry: while in flight, the entry is marked auto and stays "retrying".
    h.server.reply = () => "hold";
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.queue.get("a")?.status).toBe("sending");
    expect(h.queue.get("a")?.auto).toBe(true);
    expect(h.states()).toEqual({ a: "retrying" });
    // ⌘Z won't hijack a failed send mid-auto-retry.
    expect(h.queue.undoLast()).toBe(false);

    // Fails again, then another send piggybacks it (resume("reader") without id): still auto -> "retrying".
    h.held[0].reject(struggling());
    await flush();
    expect(h.states()).toEqual({ a: "retrying" });
    await h.queue.send(entry("b", 2));
    await flush();
    expect(h.queue.get("a")?.auto).toBe(true);
    expect(h.states().a).toBe("retrying");
    expect(h.states().b).toBe("sending");

    // Fails again; now the reader explicitly clicks Retry on card "a" -> manual -> "sending".
    h.held[1].reject(struggling());
    await flush();
    h.held[2].resolve({ memo: storedMemo("b", "b text") });
    await flush();
    h.queue.resume("reader", "a");
    await flush();
    expect(h.queue.get("a")?.status).toBe("sending");
    expect(h.queue.get("a")?.auto).toBe(false);
    expect(h.states()).toEqual({ a: "sending" });
  });

  it("lets a Retry press take over an automatic try already under way, and restarts the quick retries", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.server.reply = () => struggling();
    await h.queue.send(entry("a", 1));
    await flush();
    // Fail through two automatic tries so the clock has backed off.
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(h.create).toHaveBeenCalledTimes(2);

    // The third automatic try hangs; the card still reads "retrying" with Retry live.
    h.server.reply = () => "hold";
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();
    expect(h.create).toHaveBeenCalledTimes(3);
    expect(h.queue.get("a")?.auto).toBe(true);
    expect(h.states()).toEqual({ a: "retrying" });

    // The press joins that try: no second request, but it is the reader's now.
    h.queue.resume("reader", "a");
    await flush();
    expect(h.create).toHaveBeenCalledTimes(3);
    expect(h.queue.get("a")?.status).toBe("sending");
    expect(h.queue.get("a")?.auto).toBe(false);
    expect(h.states()).toEqual({ a: "sending" });

    // It fails: the next automatic try comes on the first, quick step again.
    h.server.reply = () => struggling();
    h.held[0].reject(struggling());
    await flush();
    expect(h.states()).toEqual({ a: "retrying" });
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(h.create).toHaveBeenCalledTimes(4);
  });
});

describe("taking back and discarding", () => {
  it("takes a send still on its way back into the composer, stops its request, and sends the one behind it", async () => {
    const h = harness();
    h.server.reply = () => "hold";
    const first = entry("a", 1, "second thoughts", [picture("img-a")]);
    await h.queue.send(first);
    await h.queue.send(entry("b", 2));
    await flush();

    expect(h.queue.takeBack("a")).toBe(true);
    expect(h.deps.recall).toHaveBeenCalledWith(first);
    expect(h.held[0].signal.aborted).toBe(true);
    expect(h.ids()).toEqual(["b"]);
    expect(h.deps.move.mock.calls[0].slice(0, 2)).toEqual(["restore", ["a"]]);
    expect(h.voice.tookBack).toHaveBeenCalledTimes(1);
    // The cache hold goes; the previews are the composer's again.
    expect(h.images.released).toEqual(["img-a"]);
    expect(h.images.revoked).toEqual([]);
    // Its request may have got through: sync is asked.
    expect(h.deps.sync).toHaveBeenCalledTimes(1);
    await flush();
    expect(h.held.map((request) => request.id)).toEqual(["a", "b"]);
    // A taking back, not a failure.
    expect(h.voice.refused).not.toHaveBeenCalled();
    expect(h.voice.retrying).not.toHaveBeenCalled();

    // It had reached the server after all: when sync brings it in, it goes to Trash.
    const reached = storedMemo("a", "second thoughts");
    h.queue.settle(new Map([["a", reached]]));
    expect(h.deps.trashReturned).toHaveBeenCalledWith(reached);
  });

  it("won't take a memo back over a draft in the composer", async () => {
    const h = harness();
    h.server.reply = () => "hold";
    await h.queue.send(entry("a", 1));
    await flush();
    h.state.composerFree = false;

    expect(h.queue.takeBack("a")).toBe(false);
    expect(h.voice.composerBusy).toHaveBeenCalledTimes(1);
    expect(h.ids()).toEqual(["a"]);
    expect(h.held[0].signal.aborted).toBe(false);
  });

  it("discards a failed send, and its Undo puts it back in its place and sends it", async () => {
    const h = harness();
    const full = () => new ApiError("STORAGE_FULL", 507, "The database is full.");
    h.server.reply = () => full();
    for (const [id, second] of [["a", 1], ["b", 2], ["c", 3]] as const) {
      await h.queue.send(entry(id, second, `${id} text`, [picture(`img-${id}`)]));
      await flush();
    }
    expect(h.states()).toEqual({ a: "refused", b: "refused", c: "refused" });

    h.queue.discard("b");
    expect(h.ids()).toEqual(["a", "c"]);
    expect(h.deps.holdFocus).toHaveBeenCalledWith("b");
    expect(h.deps.move.mock.calls.at(-1)?.slice(0, 2)).toEqual(["trash", ["b"]]);
    expect(h.refocus).toHaveBeenCalledTimes(1);
    expect(h.voice.discarded).toHaveBeenCalledTimes(1);
    // Kept for the Undo: its previews stay.
    expect(h.images.revoked).toEqual([]);

    h.server.reply = (id, content) => ({ memo: storedMemo(id, content) });
    const undo = h.voice.discarded.mock.calls[0][0] as () => void;
    const order: string[][] = [];
    h.deps.move.mockImplementation((intent: string, _ids: Iterable<string>, apply: () => void) => {
      apply();
      if (intent === "restore") order.push(h.ids());
    });
    undo();
    // Back between the two it was written between…
    expect(order).toEqual([["a", "b", "c"]]);
    await flush();
    // …and sent: the press was on it alone, so the refused ones stay as they are.
    expect(h.create.mock.calls.at(-1)?.[0]).toBe("b");
    expect(h.notebook.has("b")).toBe(true);
    expect(h.states()).toEqual({ a: "refused", c: "refused" });

    // An Undo works once.
    undo();
    await flush();
    expect(h.create.mock.calls.filter(([id]) => id === "b")).toHaveLength(2);
  });

  it("drops an Undo whose memo the server turned out to have, and keeps only as many as the toasts show", async () => {
    const h = harness();
    h.server.reply = () => new ApiError("STORAGE_FULL", 507, "The database is full.");
    for (const [id, second] of [["a", 1], ["b", 2], ["c", 3], ["d", 4]] as const) {
      await h.queue.send(entry(id, second, `${id} text`, [picture(`img-${id}`)]));
      await flush();
    }
    for (const id of ["a", "b", "c", "d"]) h.queue.discard(id);
    // The oldest one's toast has stepped off: its previews go.
    expect(h.images.revoked).toEqual(["blob:img-a"]);

    // Sync brings "d" in: its request had got through. It goes to Trash, and its Undo puts nothing back.
    const reached = storedMemo("d", "d text");
    h.notebook.set("d", reached);
    h.queue.settle(h.notebook);
    expect(h.deps.trashReturned).toHaveBeenCalledWith(reached);
    const undoD = h.voice.discarded.mock.calls[3][0] as () => void;
    undoD();
    expect(h.queue.has("d")).toBe(false);
    expect(h.images.revoked).toEqual(["blob:img-a", "blob:img-d"]);
  });

  it("takes a send confirmed a moment ago back on ⌘Z — the memo to Trash — but not once SEND_UNDO_MS has passed", async () => {
    vi.useFakeTimers();
    const h = harness();
    const sent = entry("a", 1, "oops", [picture("img-a")]);
    await h.queue.send(sent);
    await flush();
    expect(h.notebook.has("a")).toBe(true);
    // Confirmed, but ⌘Z may still want the previews back.
    expect(h.images.revoked).toEqual([]);

    expect(h.queue.undoLast()).toBe(true);
    expect(h.deps.recall).toHaveBeenCalledWith(sent);
    expect(h.deps.trashUndone).toHaveBeenCalledWith(h.notebook.get("a"), undefined);
    // trashUndone speaks the honest Trash toast itself; tookBack is only for unsent sends.
    expect(h.voice.tookBack).not.toHaveBeenCalled();
    expect(h.queue.undoLast()).toBe(false);

    // Hidden confirmed send: ⌘Z passes the sent toast id so App revises it in place.
    h.deps.shows.mockReturnValue(false);
    h.voice.sent.mockReturnValueOnce(77);
    await h.queue.send(entry("h", 2, "hidden oops"), { hidden: true });
    await flush();
    expect(h.queue.undoLast()).toBe(true);
    expect(h.deps.trashUndone).toHaveBeenCalledWith(h.notebook.get("h"), { toast: 77 });

    h.deps.shows.mockReturnValue(true);
    await h.queue.send(entry("b", 3, "fine", [picture("img-b")]));
    await flush();
    await vi.advanceTimersByTimeAsync(SEND_UNDO_MS + 1);
    expect(h.queue.undoLast()).toBe(false);
    expect(h.deps.trashUndone).toHaveBeenCalledTimes(2);
    // Out of ⌘Z's reach, its previews go.
    expect(h.images.revoked).toEqual(["blob:img-b"]);
  });

  it("takes back a send still on its way on ⌘Z, and dismisses its hidden toast if one appeared", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.deps.shows.mockReturnValue(false);
    h.server.reply = () => "hold";
    await h.queue.send(entry("a", 1), { hidden: true });
    await vi.advanceTimersByTimeAsync(BUSY_HOLD_MS);
    expect(h.voice.sending).toHaveBeenCalledWith("a");
    expect(h.queue.undoLast()).toBe(true);
    expect(h.held[0].signal.aborted).toBe(true);
    expect(h.queue.entries.size).toBe(0);
    expect(h.voice.tookBack).toHaveBeenCalledWith({ toast: 41, failed: null });
    expect(h.deps.trashUndone).not.toHaveBeenCalled();
  });
});

describe("a reload", () => {
  it("starts empty: unsent memos live in memory only, so a new page has nothing to send", () => {
    const h = harness();
    expect(h.queue.entries.size).toBe(0);
    h.queue.resume("link");
    h.queue.settle(new Map());
    expect(h.create).not.toHaveBeenCalled();
    expect(h.renders).toEqual([]);
  });

  it("counts a send whose answer was lost as sent once the next sync brings its memo in", async () => {
    const h = harness();
    h.deps.shows.mockReturnValue(false);
    h.server.reply = () => unreachable();
    h.state.online = false;
    await h.queue.send(entry("a", 1), { hidden: true });
    await flush();
    // Offline failure happened immediately inside the 150ms hold: never flashed Sending….
    expect(h.voice.sending).not.toHaveBeenCalled();
    expect(h.voice.failedHidden).toHaveBeenCalledWith("a", 0, "failed");

    const synced = storedMemo("a", "a text");
    h.queue.settle(new Map([["a", synced]]));
    expect(h.queue.entries.size).toBe(0);
    // The toast that spoke for the hidden card is the one that says it was sent.
    expect(h.voice.sent).toHaveBeenCalledWith(synced, expect.objectContaining({ toast: 42 }), false);
  });
});

describe("around the queue", () => {
  it("waits out a tag rename, rewrites only the sends known as it began, then carries on", async () => {
    const h = harness();
    h.server.reply = () => "hold";
    await h.queue.send(entry("a", 1, "first #old"));
    await h.queue.send(entry("b", 2, "second #old"));
    await flush();
    const release = h.queue.hold();
    const scope = h.queue.retagScope();
    expect([...scope]).toEqual(["a", "b"]);

    // The one in flight lands; the queue waits behind it.
    h.held[0].resolve({ memo: storedMemo("a", "first #old") });
    await flush();
    expect(h.sentIds()).toEqual(["a"]);
    // Written while the server renames: the reader's text, as typed.
    await h.queue.send(entry("c", 3, "typed during #old"));
    await flush();
    expect(h.sentIds()).toEqual(["a"]);

    h.queue.retag("old", "new", scope);
    expect(h.queue.get("b")?.content).toBe("second #new");
    expect(h.queue.get("c")?.content).toBe("typed during #old");
    h.server.reply = (id, content) => ({ memo: storedMemo(id, content) });
    release();
    // A release works once.
    release();
    await flush();
    expect(h.create.mock.calls.map(([id, content]) => [id, content])).toEqual([
      ["a", "first #old"],
      ["b", "second #new"],
      ["c", "typed during #old"]
    ]);
  });

  it("won't rewrite a send into a memo the server would refuse", async () => {
    const h = harness();
    h.server.reply = () => "hold";
    await h.queue.send(entry("bare", 1, "#work"));
    await h.queue.send(entry("pictured", 2, "#work", [picture("img-p")]));
    await h.queue.send(entry("worded", 3, "plan #work"));
    h.queue.retag("work", null, h.queue.retagScope());

    // Left empty it would fail, and take its draft with it: it stays as typed.
    expect(h.queue.get("bare")?.content).toBe("#work");
    expect(h.queue.get("bare")?.draft).toBe("#work");
    // A picture keeps a memo with no text storable; words keep one too.
    expect(h.queue.get("pictured")?.content).not.toContain("#work");
    expect(h.queue.get("worded")?.content).not.toContain("#work");
  });

  it("rewrites a discarded send kept for its Undo, so the Undo brings back the new tag", async () => {
    const h = harness();
    h.server.reply = () => new ApiError("STORAGE_FULL", 507, "The database is full.");
    await h.queue.send(entry("a", 1, "idea #work"));
    await flush();
    h.queue.discard("a");
    h.queue.retag("work", "job", h.queue.retagScope());

    h.server.reply = (id, content) => ({ memo: storedMemo(id, content) });
    (h.voice.discarded.mock.calls[0][0] as () => void)();
    await flush();
    expect(h.create.mock.calls.at(-1)?.[1]).toBe("idea #job");
  });

  it("lands each send through the landing it is given, and renders every change", async () => {
    const h = harness();
    h.server.reply = () => "hold";
    const landed: Outbox[] = [];
    await h.queue.send(entry("a", 1), {
      land: async (admit) => {
        expect(h.queue.has("a")).toBe(false);
        admit();
        landed.push(h.queue.entries);
      }
    });
    expect(landed[0].has("a")).toBe(true);
    expect(h.renders.at(-1)).toBe(h.queue.entries);
  });
});
