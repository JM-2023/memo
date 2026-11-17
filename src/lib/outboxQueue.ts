import { ApiError, AuthRequiredError } from "./api";
import { memoMatchesSubmittedDraft } from "./memoRecovery";
import { rewriteIssue } from "./memoRules";
import {
  failureOf,
  holdPreviews,
  mapEntries,
  nextQueued,
  outboxRetryDelay,
  SEND_UNDO_MS,
  withEntry,
  withoutEntry,
  type Outbox,
  type OutboxEntry,
  type OutboxFailure
} from "./outbox";
import { renameTagInContent, tagMatches } from "./tags";
import type { Memo, NewImagePayload } from "./types";

/**
 * The send pipeline's state machine ("先落卡，后确认"): the queue of sends
 * that landed as cards before the server had them, the pump that delivers
 * them, the retry clocks, and what a send taken back, discarded or undone
 * leaves behind. Plain TypeScript, no React: App hands it the server, the
 * session, the notebook, the feed's motion and the words to say as explicit
 * callbacks (OutboxDeps), so each failure mode can be driven on its own.
 * Memory only, by design (lib/outbox): a reload starts with an empty queue.
 */

/** The session a send went out in (see OutboxDeps.session). */
export interface SendSession {
  epoch: number;
  passcodeChanges: number;
}

/**
 * What sends the queue again: the reader's press (Send, Retry), the link
 * coming back (online, sync recovering, a sign-in), a send's own retry
 * clock, or a "wake" (the page back in view, a logout that didn't go
 * through).
 */
export type ResumeCue = "reader" | "link" | "wake" | "timer";

/** The feed changes the queue makes, each through the feed's motion layer. */
export type OutboxMove = "edit-save" | "purge" | "restore" | "trash";

/** What the queue has to say. The words, and where they go, are App's. */
export interface OutboxVoice {
  /** A send whose card the view hides is on its way. Returns the toast speaking for the card. */
  sending(id: string): number;
  /** A send whose card the view hides failed. `toast` is the one speaking for it (0: none); returns the one that says so now. */
  failedHidden(id: string, toast: number): number;
  /**
   * The server has the memo. `said`: the toast that spoke for a hidden
   * card, if any; `leaves`: its server time moved it out of the view its
   * card was in.
   */
  sent(saved: Memo, said: { toast: number } | undefined, leaves: boolean): void;
  /** A send in view failed on its own while online and is trying again (said once per run of tries). */
  retrying(): void;
  /** The queue stopped with the browser offline, a card in view among those waiting. */
  offline(): void;
  /** The server turned a send in view away for good; `cause` carries its reason. */
  refused(cause: unknown): void;
  /** A send stored once already and deleted for good elsewhere since: nothing left to send. */
  purged(): void;
  /** Nothing goes back into a composer that holds a draft. */
  composerBusy(): void;
  /** A memo went back into the composer. */
  tookBack(): void;
  /** A failed send was discarded; `undo` puts it back in its place. */
  discarded(undo: () => void): void;
}

export interface OutboxDeps {
  /** The create a send makes (api.createMemo). */
  create(id: string, content: string, images: NewImagePayload[], options: { signal: AbortSignal }): Promise<{ memo: Memo; idempotent?: boolean }>;
  /** The version-checked update that brings a stored memo level with its send (api.updateMemo). */
  update(
    id: string,
    changes: { expectedSeq: number; content: string; addImages: NewImagePayload[]; removeImageIds: string[] },
    options: { signal: AbortSignal }
  ): Promise<{ memo?: Memo }>;

  /** Signed in, the notebook on screen. */
  signedIn(): boolean;
  /** A passcode change under way: the cookie is changing hands. */
  changingPasscode(): boolean;
  /** A logout under way, from the press of Log Out until the gate shows. */
  leaving(): boolean;
  /**
   * The session as it stands. Opening the passcode dialog renews the
   * session epoch too, so that nothing answered with the old cookie can drop
   * the tab to the gate — but the notebook after it is the same one, and a
   * send answered across it is still this notebook's memo.
   */
  session(): SendSession;
  /** The session is gone under the owner: to the gate. */
  dropToLogin(): void;

  /** The memo the server truth holds under `id`, if it does. */
  stored(id: string): Memo | undefined;
  /** Put a send's stored memo into the server truth (inside `move`'s change). */
  store(saved: Memo): void;
  /** The same, as a change that arrives on its own (a send taken back that was stored after all). */
  storeRemote(saved: Memo): void;
  /** Pull the server's changes now. */
  sync(): void;
  /** Tell the other tabs something changed. */
  notifyPeers(): void;

  /** Whether the feed as it stands shows `memo`. */
  shows(memo: Memo): boolean;
  /** Change the feed through its motion layer: `apply` commits at once, and the cards move from where the reader saw them. */
  move(intent: OutboxMove, ids: Iterable<string>, apply: () => void): void;
  /** Keep focus at the reader's place while `id`'s card leaves; returns the hand-back. */
  holdFocus(id: string): () => void;
  /** Put a send back into the composer. False when the composer holds anything: a draft is never clobbered. */
  recall(entry: OutboxEntry): boolean;
  /** Whether a pin, trash or restore of the memo is in flight. */
  busy(id: string): boolean;
  /** ⌘Z after the server confirmed the send: the memo goes to Trash. */
  trashUndone(memo: Memo): void;
  /** A send taken back or discarded that reached the server after all: it goes to Trash. */
  trashReturned(memo: Memo): void;

  voice: OutboxVoice;

  /** The browser's word on the connection. */
  online?(): boolean;
  /** Whether the page is in view. */
  visible?(): boolean;
  /** Hold a send's pictures in the image cache (lib/outbox holdPreviews); returns the release. */
  holdImages?(images: readonly NewImagePayload[]): () => void;
  /** Let a composer preview go (URL.revokeObjectURL). */
  revoke?(url: string): void;
}

export interface OutboxQueueOptions {
  /** Every change of the queue, as it happens (App's state setter). */
  onChange?: (outbox: Outbox) => void;
  /** Discarded sends kept for their toast's Undo: as many as the toast stack shows at once. */
  keepDiscarded?: number;
}

type Timer = ReturnType<typeof setTimeout>;

interface LastSend {
  entry: OutboxEntry;
  confirmedAt: number | null;
  timer: Timer | undefined;
}

function browserOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function pageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export class OutboxQueue {
  // Delivered one at a time in the order they were sent, so their server
  // times keep that order (a send that keeps failing steps aside, see
  // pump). Memory only, like the composer's draft: a logout discards it, a
  // lost session keeps it for the next sign-in.
  private outbox: Outbox = new Map();
  private wiring: OutboxDeps | null;
  private readonly onChange?: (outbox: Outbox) => void;
  private readonly keepDiscarded: number;

  // The work around it, none of it rendered.
  private pumping = false;
  /** The request in flight, by memo id. */
  private readonly controllers = new Map<string, AbortController>();
  /** Memos whose request may have reached the server. */
  private readonly attempted = new Set<string>();
  /** Taken back or discarded after an attempt: should the server turn out to have one, it goes to Trash (see settle). */
  private readonly retracted = new Set<string>();
  /** Each entry's hold on its pictures in the image cache. */
  private readonly previews = new Map<string, () => void>();
  /** Automatic retries each failed send has spent since the reader, the link or a sign-in last restarted it. */
  private readonly retries = new Map<string, number>();
  /** Each failed send's own retry clock (retryLater). */
  private readonly timers = new Map<string, Timer>();
  /** Tag renames and removals under way: the queue waits them out (hold). */
  private holds = 0;
  /** Sends whose card the view hides: the toast speaking for the card, and whether it has said the send failed. */
  private readonly hidden = new Map<string, { toast: number; failed: boolean }>();
  /** Discarded entries kept for their toast's Undo, oldest first. */
  private discarded: OutboxEntry[] = [];
  /** The latest send, for ⌘Z in the composer it just emptied. */
  private last: LastSend | null = null;

  constructor(deps: OutboxDeps | null = null, options: OutboxQueueOptions = {}) {
    this.wiring = deps;
    this.onChange = options.onChange;
    this.keepDiscarded = options.keepDiscarded ?? 3;
  }

  /** Hand the queue the latest callbacks (App does, every render): async work always reads the current ones. */
  connect(deps: OutboxDeps): void {
    this.wiring = deps;
  }

  /** The sends on their way, oldest first. */
  get entries(): Outbox {
    return this.outbox;
  }

  get(id: string): OutboxEntry | undefined {
    return this.outbox.get(id);
  }

  has(id: string): boolean {
    return this.outbox.has(id);
  }

  private get deps(): OutboxDeps {
    if (!this.wiring) throw new Error("The outbox queue was used before it was connected");
    return this.wiring;
  }

  private get voice(): OutboxVoice {
    return this.deps.voice;
  }

  private online(): boolean {
    return (this.deps.online ?? browserOnline)();
  }

  private visible(): boolean {
    return (this.deps.visible ?? pageVisible)();
  }

  private holdImages(images: readonly NewImagePayload[]): () => void {
    return (this.deps.holdImages ?? holdPreviews)(images);
  }

  private write(change: (current: Outbox) => Outbox): void {
    const next = change(this.outbox);
    if (next === this.outbox) return;
    this.outbox = next;
    this.onChange?.(next);
  }

  /**
   * Send. The memo lands as its card at once — `land` gets the change that
   * puts it in the feed, to make inside the composer→card morph — and goes
   * to the server behind that (pump). `hidden`: the view the reader is in
   * leaves the card out, so a toast speaks for it.
   */
  async send(entry: OutboxEntry, options: { hidden?: boolean; land?: (admit: () => void) => Promise<void> } = {}): Promise<void> {
    const id = entry.id;
    // Marked before it can go out: a send that settles first says so itself (landSent).
    if (options.hidden) this.hidden.set(id, { toast: 0, failed: false });
    // Before the landing: its morph decodes the pictures from the cache.
    this.previews.set(id, this.holdImages(entry.images));
    this.noteLastSend(entry);
    const admit = () => this.write((current) => withEntry(current, entry));
    if (options.land) await options.land(admit);
    else admit();
    const said = this.hidden.get(id);
    if (said && !said.toast && !said.failed) {
      // Only on its way yet: the toast speaks for the hidden card until the
      // send settles, saved (landSent) or not (sayHiddenFailure).
      said.toast = this.voice.sending(id);
    }
    // A press is a fresh try for anything still waiting in front of it.
    this.resume("reader");
  }

  /** The latest send, for ⌘Z: the one before it is out of reach now. */
  private noteLastSend(entry: OutboxEntry): void {
    const previous = this.last;
    if (previous) {
      clearTimeout(previous.timer);
      if (previous.confirmedAt !== null) this.revokePreviews(previous.entry);
    }
    this.last = { entry, confirmedAt: null, timer: undefined };
  }

  /** An entry's previews are the queue's until the memo is stored, discarded for good or taken back. */
  private revokePreviews(entry: OutboxEntry): void {
    const revoke = this.deps.revoke ?? ((url: string) => URL.revokeObjectURL(url));
    for (const image of entry.images) revoke(image.previewUrl);
  }

  private releaseHold(id: string): void {
    this.previews.get(id)?.();
    this.previews.delete(id);
  }

  /**
   * Not now: while the cookie is changing hands (as useSync pauses), a
   * logout is under way or a tag is being renamed or removed under the
   * queue (hold).
   */
  private paused(): boolean {
    return !this.deps.signedIn() || this.deps.changingPasscode() || this.deps.leaving() || this.holds > 0;
  }

  /**
   * Deliver the queue, oldest first, one request at a time. A lost session
   * stops the queue (the next sign-in sends the rest), and so does a
   * failure while the browser is offline: every send behind it would meet
   * the same, and they all say so (block). Any other failure is that one
   * send's own: it tries again on its own clock (retryLater) while the
   * queue goes on past it, so one send the server keeps failing never holds
   * up the rest. The sends behind it may then reach the server first and
   * take earlier server times: the order holds while sends go through,
   * never at the cost of sending.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.paused()) return;
        const entry = nextQueued(this.outbox);
        if (!entry) return;
        const failure = await this.deliver(entry);
        if (failure === "auth" || (failure === "network" && !this.online())) {
          this.block(failure);
          return;
        }
        if (failure === "network") this.retryLater(entry.id);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** The session ended since `from` (a logout, an expiry, a sign-in), not just a passcode change. */
  private sessionLost(from: SendSession): boolean {
    const now = this.deps.session();
    return now.epoch - from.epoch !== now.passcodeChanges - from.passcodeChanges;
  }

  /** One send. Resolves to why it failed, or null once it is settled (sent, or gone from the queue). */
  private async deliver(entry: OutboxEntry): Promise<OutboxFailure | null> {
    const controller = new AbortController();
    this.controllers.set(entry.id, controller);
    this.attempted.add(entry.id);
    const session = this.deps.session();
    const imageIds = entry.images.map((image) => image.id);
    try {
      const result = await this.deps.create(entry.id, entry.content, entry.images, { signal: controller.signal });
      let saved = result.memo;
      // What the memo should say now: a tag renamed or removed while the
      // request was out rewrote the entry after it left (retag).
      const wanted = this.outbox.get(entry.id)?.content ?? entry.content;
      if ((result.idempotent || wanted !== entry.content) && !memoMatchesSubmittedDraft(saved, wanted, imageIds)) {
        // An earlier create committed but its answer was lost, and what is
        // stored differs from this send — or the send was rewritten on its
        // way: bring it level with a version-checked update instead of
        // making a second memo.
        const stored = new Set(saved.images.map((image) => image.id));
        const kept = new Set(imageIds);
        const resumed = await this.deps.update(
          saved.id,
          {
            expectedSeq: saved.seq,
            content: wanted,
            addImages: entry.images.filter((image) => !stored.has(image.id)),
            removeImageIds: saved.images.filter((image) => !kept.has(image.id)).map((image) => image.id)
          },
          { signal: controller.signal }
        );
        if (resumed.memo) saved = resumed.memo;
      }
      this.landSent(entry, saved, session);
      return null;
    } catch (cause) {
      // The memo reached the server before (its answer lost) and has
      // changed there since — trashed or edited elsewhere, or by the
      // recovery update above. It was sent; the server's version stands.
      if (cause instanceof ApiError && cause.code === "VERSION_CONFLICT" && cause.current) {
        this.landSent(entry, cause.current, session);
        return null;
      }
      // Taken back, discarded or logged out meanwhile: nothing left to say.
      if (!this.outbox.has(entry.id) || controller.signal.aborted) return null;
      // Turned away as a logout ends the session: the gate is coming anyway,
      // and a logout the server didn't confirm sends it again.
      if (this.deps.leaving()) return null;
      // The session changed under the request: the next sign-in sends it.
      if (this.sessionLost(session)) return "auth";
      if (cause instanceof AuthRequiredError) {
        // Turned away with the cookie a passcode change replaced: it waits
        // out the change (paused) and goes again with the new one.
        if (session.epoch !== this.deps.session().epoch) return null;
        this.deps.dropToLogin();
        return "auth";
      }
      // A sync brought the memo in meanwhile: the server had it all along.
      const synced = this.deps.stored(entry.id);
      if (synced) {
        this.landSent(entry, synced, session);
        return null;
      }
      if (cause instanceof ApiError && cause.code === "MEMO_ID_RETIRED") {
        // Sent once already, then deleted for good elsewhere: there is
        // nothing left to send.
        this.deps.move("purge", [entry.id], () => this.write((current) => withoutEntry(current, entry.id)));
        this.finishSent(entry);
        this.voice.purged();
        return null;
      }
      const failure = failureOf(cause, this.online());
      if (failure === "refused") {
        this.write((current) => mapEntries(current, (item) => item.id === entry.id, (item) => ({ ...item, status: "failed", failure })));
        // A card in view says it beside its Retry, and the voice gives the
        // server's reason; a hidden one's toast says where it is.
        if (!this.sayHiddenFailure(entry.id)) this.voice.refused(cause);
      }
      return failure;
    } finally {
      if (this.controllers.get(entry.id) === controller) this.controllers.delete(entry.id);
    }
  }

  /**
   * The server has the memo. It takes the card's place in the same slot —
   * no second entrance; the stamp dissolves from the send's state to its
   * time (MemoCard) — and the queue lets go of it.
   */
  private landSent(entry: OutboxEntry, saved: Memo, session: SendSession): void {
    if (this.sessionLost(session)) {
      // Answered across a change of session: the next sign-in's notebook
      // (or a sync) brings the memo in.
      if (this.outbox.has(entry.id)) {
        this.write((current) => withoutEntry(current, entry.id));
        this.finishSent(entry);
      }
      return;
    }
    const current = this.outbox.get(entry.id);
    if (!current) {
      // Taken back or discarded while the answer was on its way: the memo
      // is stored after all, so it shows, and the watch on taken-back ids
      // moves it to Trash (settle).
      this.deps.storeRemote(saved);
      this.deps.sync();
      this.deps.notifyPeers();
      return;
    }
    // A memo stamped later than its card (a send that waited out a
    // connection) can fall out of a day the card was in; one the view hid
    // all along had a toast speaking for it.
    const said = this.hidden.get(entry.id);
    const shows = this.deps.shows(saved);
    const leaves = this.deps.shows(current.memo) && !shows;
    // A later server time can also move it among its neighbours: it glides.
    this.deps.move("edit-save", new Set([entry.id, saved.id]), () => {
      this.deps.store(saved);
      this.write((outbox) => withoutEntry(outbox, entry.id));
    });
    this.finishSent(current);
    this.deps.sync();
    this.deps.notifyPeers();
    this.voice.sent(saved, said, leaves);
  }

  /** An entry the server has: its pictures leave the cache hold, and its previews go — once ⌘Z can no longer want them back. */
  private finishSent(entry: OutboxEntry): void {
    this.attempted.delete(entry.id);
    this.forgetSend(entry.id);
    this.releaseHold(entry.id);
    const last = this.last;
    if (!last || last.entry.id !== entry.id) {
      this.revokePreviews(entry);
      return;
    }
    last.entry = entry;
    last.confirmedAt = Date.now();
    clearTimeout(last.timer);
    last.timer = setTimeout(() => {
      if (this.last !== last) return;
      this.last = null;
      this.revokePreviews(last.entry);
    }, SEND_UNDO_MS);
  }

  /** A send's retry clock stops, and the tries it has spent are forgotten. */
  private stopRetrying(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.retries.delete(id);
  }

  /** A send settled or gone (sent, taken back, discarded): nothing of its clock or its toast stays. */
  private forgetSend(id: string): void {
    this.stopRetrying(id);
    this.hidden.delete(id);
  }

  /**
   * A send failed whose card the view hides: nothing on screen says so, so
   * a toast does — once, taking over the one that said it was on its way —
   * with the way to the card and its Retry. True when the card is hidden
   * (said now or before); false when it is in view and says it itself.
   */
  private sayHiddenFailure(id: string): boolean {
    const entry = this.outbox.get(id);
    if (!entry || this.deps.shows(entry.memo)) return false;
    const said = this.hidden.get(id);
    if (said?.failed) return true;
    const toast = this.voice.failedHidden(id, said?.toast ?? 0);
    this.hidden.set(id, { toast, failed: true });
    return true;
  }

  /**
   * A send that failed on its own while online: its card says it is trying
   * again (MemoCard), and it does, on its own clock — a few quick retries,
   * then one a minute for as long as it keeps failing. The clock waits
   * while the page is out of sight or the connection is gone (resume);
   * coming back to the page, or online, sends it.
   */
  private retryLater(id: string): void {
    const spent = this.retries.get(id) ?? 0;
    this.write((current) => mapEntries(current, (entry) => entry.id === id, (entry) => ({ ...entry, status: "failed", failure: "network" })));
    // Said once; the retries after it stay quiet. (A hidden card's toast says it.)
    if (spent === 0 && !this.sayHiddenFailure(id)) this.voice.retrying();
    clearTimeout(this.timers.get(id));
    this.retries.set(id, spent + 1);
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.resume("timer", id);
      }, outboxRetryDelay(spent))
    );
  }

  /**
   * The queue stopped on a failure every waiting send shares — the browser
   * offline, or the session lost: they all say so. The connection coming
   * back is the cue to go again (listen, and App's link watch), and a lost
   * session's is the next sign-in, which says its own words on the gate.
   */
  private block(failure: "network" | "auth"): void {
    const waiting = [...this.outbox.values()].filter((entry) => entry.status === "sending").map((entry) => entry.id);
    this.write((current) => mapEntries(current, (entry) => entry.status === "sending", (entry) => ({ ...entry, status: "failed", failure })));
    if (failure !== "network") return;
    let inView = false;
    for (const id of waiting) if (!this.sayHiddenFailure(id)) inView = true;
    if (inView) this.voice.offline();
  }

  /**
   * Send again what failed (see ResumeCue). Only a press retries a refused
   * memo — the one it was pressed on. A clock that runs out while the page
   * is out of sight or offline sends nothing: coming back does.
   */
  resume(from: ResumeCue, id?: string): void {
    if (!this.deps.signedIn() || this.deps.leaving()) return;
    if ((from === "timer" || from === "wake") && (!this.visible() || !this.online())) return;
    const picked = (entry: OutboxEntry) =>
      entry.status === "failed" &&
      (from === "timer"
        ? entry.id === id
        : from === "wake"
          ? entry.failure === "network" && !this.timers.has(entry.id)
          : entry.failure !== "refused" || entry.id === id);
    // A press or the link is a fresh start: the quick retries come first again.
    if (from === "reader" || from === "link") for (const entry of this.outbox.values()) if (picked(entry)) this.stopRetrying(entry.id);
    this.write((current) => mapEntries(current, picked, (entry) => ({ ...entry, status: "sending", failure: null })));
    void this.pump();
  }

  /**
   * 撤回 while sending, 编辑 once failed: the memo goes back into the
   * composer — what Esc did to a send in flight before sends landed at the
   * press — and its card lifts away toward it. Should the request have
   * reached the server anyway, the memo is moved to Trash when it shows up
   * (settle).
   */
  takeBack(id: string): boolean {
    const entry = this.outbox.get(id);
    if (!entry || this.deps.stored(id)) return false;
    if (!this.deps.recall(entry)) {
      this.voice.composerBusy();
      return false;
    }
    this.controllers.get(id)?.abort();
    this.forgetSend(id);
    const reached = this.attempted.delete(id);
    if (reached) this.retracted.add(id);
    if (this.last?.entry.id === id) {
      clearTimeout(this.last.timer);
      this.last = null;
    }
    // The previews are the composer's again; only the cache hold goes.
    this.releaseHold(id);
    this.deps.move("restore", [id], () => this.write((current) => withoutEntry(current, id)));
    this.voice.tookBack();
    if (reached) this.deps.sync();
    // The queue behind it goes on.
    void this.pump();
    return true;
  }

  /** 舍弃 on a failed card: it leaves, and its toast's Undo puts it back in its place. */
  discard(id: string): void {
    const entry = this.outbox.get(id);
    if (!entry || this.deps.stored(id)) return;
    this.controllers.get(id)?.abort();
    this.forgetSend(id);
    const reached = this.attempted.delete(id);
    if (reached) this.retracted.add(id);
    if (this.last?.entry.id === id) {
      clearTimeout(this.last.timer);
      this.last = null;
    }
    this.releaseHold(id);
    // Kept for the Undo, as many as the toast stack shows at once.
    this.discarded.push(entry);
    for (const stale of this.discarded.splice(0, Math.max(0, this.discarded.length - this.keepDiscarded))) this.revokePreviews(stale);
    const refocus = this.deps.holdFocus(id);
    this.deps.move("trash", [id], () => this.write((current) => withoutEntry(current, id)));
    refocus();
    this.voice.discarded(() => this.restoreDiscarded(entry, reached));
  }

  private restoreDiscarded(entry: OutboxEntry, reached: boolean): void {
    const at = this.discarded.indexOf(entry);
    if (at < 0) return;
    this.discarded.splice(at, 1);
    this.retracted.delete(entry.id);
    // The server had it all along (sync brought it in): it is there already.
    if (this.deps.stored(entry.id)) {
      this.revokePreviews(entry);
      return;
    }
    if (reached) this.attempted.add(entry.id);
    this.previews.set(entry.id, this.holdImages(entry.images));
    this.deps.move("restore", [entry.id], () => this.write((current) => withEntry(current, entry)));
    this.resume("reader", entry.id);
  }

  /**
   * ⌘Z in the composer a send just emptied: a send still on its way is
   * taken back (撤回); one the server confirmed less than SEND_UNDO_MS ago
   * goes to Trash, its text and pictures back in the composer.
   */
  undoLast(): boolean {
    const last = this.last;
    if (!last) return false;
    if (last.confirmedAt === null) return this.outbox.get(last.entry.id)?.status === "sending" && this.takeBack(last.entry.id);
    if (Date.now() - last.confirmedAt > SEND_UNDO_MS) return false;
    const memo = this.deps.stored(last.entry.id);
    if (!memo || memo.deletedAt || this.deps.busy(memo.id) || !this.deps.recall(last.entry)) return false;
    clearTimeout(last.timer);
    this.last = null;
    this.voice.tookBack();
    this.deps.trashUndone(memo);
    return true;
  }

  /**
   * What sync says about the queue, as the server truth moves. A memo it
   * brings in that waits here with no request in flight was stored all
   * along (its answer lost): sent. One taken back or discarded that it
   * brings in goes to Trash.
   */
  settle(memos: ReadonlyMap<string, Memo>): void {
    for (const entry of this.outbox.values()) {
      const memo = memos.get(entry.id);
      if (this.controllers.has(entry.id) || !memo) continue;
      const said = this.hidden.get(entry.id);
      this.write((current) => withoutEntry(current, entry.id));
      this.finishSent(entry);
      this.voice.sent(memo, said, false);
    }
    for (const id of [...this.retracted]) {
      const memo = memos.get(id);
      if (!memo) continue;
      this.retracted.delete(id);
      if (!memo.deletedAt && !this.outbox.has(id)) this.deps.trashReturned(memo);
    }
  }

  /**
   * Hold the queue while a tag is renamed or removed on the server: a send
   * stored half-way through would keep the old tag. Returns the release,
   * which carries on with what waited.
   */
  hold(): () => void {
    this.holds += 1;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.holds -= 1;
      if (this.holds === 0) void this.pump();
    };
  }

  /**
   * The sends a tag rename or removal may rewrite: those waiting, kept for
   * an Undo or for ⌘Z as it began — the ones refuseTagRewrite checked. A
   * send made while the server works is the reader's text as typed.
   */
  retagScope(): ReadonlySet<string> {
    const ids = new Set(this.outbox.keys());
    for (const entry of this.discarded) ids.add(entry.id);
    if (this.last) ids.add(this.last.entry.id);
    return ids;
  }

  /**
   * A tag renamed (or removed: `to` null) reaches the sends on their way
   * too, as the server's rewrite reached the stored memos — their text, the
   * draft taken back from them, the lens tag they inherited and their
   * cards — or a send stored later would bring the old tag back. A send
   * already out is brought level as it lands (deliver). Only the sends in
   * `scope` (retagScope, taken as the change began) are touched, and none
   * is rewritten into text the server would refuse: a send left empty
   * would fail, and take its draft with it.
   */
  retag(from: string, to: string | null, scope: ReadonlySet<string>): void {
    const moved = (tag: string | null) => (tag !== null && tagMatches(tag, from) ? (to === null ? null : to + tag.slice(from.length)) : tag);
    const retag = (entry: OutboxEntry): OutboxEntry => {
      const content = renameTagInContent(entry.content, from, to);
      return { ...entry, content, draft: renameTagInContent(entry.draft, from, to), tag: moved(entry.tag), memo: { ...entry.memo, content } };
    };
    const changes = (entry: OutboxEntry) => {
      if (!scope.has(entry.id)) return false;
      const content = renameTagInContent(entry.content, from, to);
      if (rewriteIssue(entry.content, content, entry.images.length)) return false;
      return content !== entry.content || renameTagInContent(entry.draft, from, to) !== entry.draft || moved(entry.tag) !== entry.tag;
    };
    this.write((current) => mapEntries(current, changes, retag));
    // Kept for a toast's Undo and for ⌘Z: they would put the old tag back
    // too. Rewritten in place, as the Undo finds its entry by identity.
    for (const entry of this.discarded) if (changes(entry)) Object.assign(entry, retag(entry));
    if (this.last && changes(this.last.entry)) this.last.entry = retag(this.last.entry);
  }

  /** Stops every send's retry clock (a logout under way, the queue discarded). */
  stopClocks(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * The wipe a revoked session brings (clearLocalDeviceData) empties the
   * image cache as it starts, under the unsent cards too — and those wait
   * for the next sign-in: their pictures go back in from the payloads they
   * carry, ahead of any card drawing them again.
   */
  rehold(): void {
    for (const entry of this.outbox.values()) {
      this.previews.get(entry.id)?.();
      this.previews.set(entry.id, this.holdImages(entry.images));
    }
  }

  /** Logout: unsent memos go with the drafts. */
  discardAll(): void {
    this.stopClocks();
    this.retries.clear();
    this.hidden.clear();
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    for (const release of this.previews.values()) release();
    this.previews.clear();
    const owned = new Set([...this.outbox.values(), ...this.discarded]);
    if (this.last) {
      clearTimeout(this.last.timer);
      owned.add(this.last.entry);
    }
    for (const entry of owned) this.revokePreviews(entry);
    this.discarded = [];
    this.last = null;
    this.attempted.clear();
    this.retracted.clear();
    this.write(() => new Map());
  }

  /**
   * The link coming back is the retry the reader would have pressed: the
   * browser going online. The page coming back into view sends what its
   * clocks held while it was hidden. Returns the unhook.
   */
  listen(): () => void {
    if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
    const onOnline = () => this.resume("link");
    const onVisible = () => {
      if (document.visibilityState === "visible") this.resume("wake");
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }

  /** The page going away: no clock outlives it. */
  dispose(): void {
    this.stopClocks();
    if (this.last) clearTimeout(this.last.timer);
  }
}
