// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor, type ComposerControl, type EditorSubmission } from "../src/components/Editor";
import { TipProvider } from "../src/components/Tip";
import { LanguageProvider } from "../src/lib/i18n";
import { addLayer } from "../src/lib/layerStack";
import { LIVE_REGION_ATTR, mountLiveRegions } from "../src/lib/liveAnnouncer";
import type { MemoImage, NewImagePayload } from "../src/lib/types";

const imageMocks = vi.hoisted(() => ({ compressImage: vi.fn() }));

vi.mock("../src/lib/images", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/images")>("../src/lib/images");
  return { ...actual, compressImage: imageMocks.compressImage };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function pendingImage(id: string): NewImagePayload {
  return { id, dataBase64: "AA==", mime: "image/webp", width: 1, height: 1, previewUrl: `blob:${id}` };
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <TipProvider>{children}</TipProvider>
    </LanguageProvider>
  );
}

function field(): HTMLTextAreaElement {
  return screen.getByRole("combobox", { name: "Memo content" }) as HTMLTextAreaElement;
}

function shownError(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".editor-note.is-open .editor-error");
}

function spoken(tone: "status" | "alert"): string {
  return document.querySelector(`[${LIVE_REGION_ATTR}] [role="${tone}"]`)?.textContent ?? "";
}

function stored(index: number): MemoImage {
  return { id: `stored-${index}`, mime: "image/webp", width: 1, height: 1, bytes: 1 };
}

/** An owner whose request waits until the editor's signal fires. */
function abortableSubmit(settle: "resolve-false" | "reject") {
  const calls: EditorSubmission[] = [];
  const onSubmit = vi.fn(
    (data: EditorSubmission) =>
      new Promise<boolean>((resolve, reject) => {
        calls.push(data);
        data.signal?.addEventListener("abort", () => {
          if (settle === "resolve-false") resolve(false);
          else reject(new DOMException("Aborted", "AbortError"));
        });
      })
  );
  return { onSubmit, calls };
}

let unmountRegions: () => void = () => undefined;

beforeEach(() => {
  unmountRegions = mountLiveRegions();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({ matches: query === "(pointer: fine)", media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  });
});

afterEach(() => {
  cleanup();
  unmountRegions();
  vi.clearAllMocks();
});

// A send lands at once (App's outbox), so only a save in the inline editor
// waits on the server — and only it is stopped with Esc.
describe("Editor in-flight save", () => {
  it("stops a save in flight on Esc and hands the field back as it was", async () => {
    const user = userEvent.setup();
    const { onSubmit, calls } = abortableSubmit("resolve-false");
    render(
      <Providers>
        <Editor mode="edit" initialContent="" knownTags={[]} busy={false} onSubmit={onSubmit} onCancel={vi.fn()} />
      </Providers>
    );
    await user.type(field(), "half a thought");
    field().setSelectionRange(2, 6);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(calls[0].signal?.aborted).toBe(false);
    // The field is busy: it takes no typing until the answer is in.
    expect(field().readOnly).toBe(true);
    expect(field().closest(".editor")?.getAttribute("aria-busy")).toBe("true");
    // Moving the caret meanwhile does not survive the stop.
    field().setSelectionRange(0, 0);

    fireEvent.keyDown(field(), { key: "Escape" });
    expect(calls[0].signal?.aborted).toBe(true);
    await waitFor(() => expect(field().readOnly).toBe(false));
    expect(field().value).toBe("half a thought");
    expect([field().selectionStart, field().selectionEnd]).toEqual([2, 6]);
    expect(document.activeElement).toBe(field());
    // A stop is not a failure.
    expect(shownError()).toBeNull();
  });

  it("treats an owner's abort rejection as a stop, not a failure", async () => {
    const user = userEvent.setup();
    const { onSubmit, calls } = abortableSubmit("reject");
    render(
      <Providers>
        <Editor mode="edit" initialContent="" knownTags={[]} busy={false} onSubmit={onSubmit} onCancel={vi.fn()} />
      </Providers>
    );
    await user.type(field(), "draft");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(field(), { key: "Escape" });
    await waitFor(() => expect(field().readOnly).toBe(false));
    expect(calls[0].signal?.aborted).toBe(true);
    expect(field().value).toBe("draft");
    expect(shownError()).toBeNull();
    expect(spoken("alert")).toBe("");
    // The same draft goes again under the same id, so a request that got
    // through after all is found rather than doubled.
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(calls[1].clientId).toBe(calls[0].clientId);
  });

  it("has nothing left to stop once the owner lands the memo", async () => {
    const user = userEvent.setup();
    let signal: AbortSignal | undefined;
    let finish: (ok: boolean) => void = () => undefined;
    const onSubmit = vi.fn(
      (data: EditorSubmission) =>
        new Promise<boolean>((resolve) => {
          signal = data.signal;
          finish = (ok) => {
            data.onCommitted?.(false);
            resolve(ok);
          };
        })
    );
    render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={onSubmit} />
      </Providers>
    );
    await user.type(field(), "landing");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    act(() => {
      // Committed in the owner's update, while the promise is still out.
      finish(true);
      fireEvent.keyDown(field(), { key: "Escape" });
    });
    expect(signal?.aborted).toBe(false);
    await waitFor(() => expect(field().value).toBe(""));
  });

  it("stops a save in the inline editor without discarding the edit", async () => {
    const user = userEvent.setup();
    const { onSubmit, calls } = abortableSubmit("resolve-false");
    const onCancel = vi.fn();
    render(
      <Providers>
        <Editor mode="edit" initialContent="original" knownTags={[]} busy={false} onSubmit={onSubmit} onCancel={onCancel} autoFocus />
      </Providers>
    );
    await user.type(field(), " changed");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(calls[0].signal?.aborted).toBe(true);
    await waitFor(() => expect(field().readOnly).toBe(false));
    expect(onCancel).not.toHaveBeenCalled();
    expect(field().value).toBe("original changed");
    // The next Esc is the usual one: the edit is discarded.
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("Editor as the composer after a send", () => {
  it("takes a sent memo back in — text, pictures and caret — only into an empty composer", async () => {
    const user = userEvent.setup();
    // The composer owns the preview again, and releases it when it goes.
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const control: { current: ComposerControl | null } = { current: null };
    const onOccupiedChange = vi.fn();
    render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={vi.fn(async () => true)} controlRef={control} onOccupiedChange={onOccupiedChange} />
      </Providers>
    );
    expect(onOccupiedChange).toHaveBeenLastCalledWith(false);
    const image: NewImagePayload = { id: "back-1", dataBase64: "AA==", mime: "image/webp", width: 1, height: 1, previewUrl: "blob:back-1" };
    let taken = false;
    act(() => {
      taken = control.current?.recall({ content: "back again", newImages: [image], selectionStart: 2, selectionEnd: 4 }) ?? false;
    });
    expect(taken).toBe(true);
    expect(field().value).toBe("back again");
    expect([field().selectionStart, field().selectionEnd]).toEqual([2, 4]);
    expect(document.activeElement).toBe(field());
    expect(document.querySelector<HTMLElement>(".attachment[data-image-id='back-1'] img")?.getAttribute("src")).toBe("blob:back-1");
    expect(onOccupiedChange).toHaveBeenLastCalledWith(true);

    // A draft is never clobbered.
    await user.type(field(), "!");
    act(() => {
      taken = control.current?.recall({ content: "another", newImages: [], selectionStart: 0, selectionEnd: 0 }) ?? false;
    });
    expect(taken).toBe(false);
    expect(field().value).toBe("back again!");
  });

  it("hands ⌘Z to the owner only in the composer a send just emptied", async () => {
    const user = userEvent.setup();
    const onUndoSend = vi.fn(() => true);
    const onSubmit = vi.fn(async (data: EditorSubmission) => {
      data.onCommitted?.(false);
      return true;
    });
    render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={onSubmit} onUndoSend={onUndoSend} />
      </Providers>
    );
    // Nothing sent yet: the field's own undo.
    expect(fireEvent.keyDown(field(), { key: "z", metaKey: true })).toBe(true);
    expect(onUndoSend).not.toHaveBeenCalled();

    await user.type(field(), "sent");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(field().value).toBe(""));
    expect(onSubmit.mock.calls[0][0].selection).toEqual({ start: 4, end: 4 });
    expect(fireEvent.keyDown(field(), { key: "z", metaKey: true })).toBe(false);
    expect(onUndoSend).toHaveBeenCalledTimes(1);

    // Typed into since: ⌘Z is the field's again.
    await user.type(field(), "x");
    await user.clear(field());
    expect(fireEvent.keyDown(field(), { key: "z", ctrlKey: true })).toBe(true);
    expect(onUndoSend).toHaveBeenCalledTimes(1);
  });
});

describe("Editor notes arrive once", () => {
  it("opens on the fold alone, and rises only for a complaint replacing one on show", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={vi.fn(async () => true)} />
      </Providers>
    );
    await user.click(screen.getByRole("button", { name: "Insert image link" }));
    const link = document.querySelector(".link-pop-inner input") as HTMLInputElement;
    await user.type(link, "not a url{Enter}");
    const first = shownError();
    expect(first?.textContent).toBe("Enter an image URL beginning with http(s)://");
    expect(first?.classList.contains("is-replacing")).toBe(false);
    expect(first?.getAttribute("role")).toBeNull();
    expect(spoken("alert")).toBe("Enter an image URL beginning with http(s)://");

    // Again while it is open: a new line that rises in over the old one.
    await user.type(link, "{Enter}");
    const second = shownError();
    expect(second).not.toBe(first);
    expect(second?.classList.contains("is-replacing")).toBe(true);
    // Re-rendering does not replay it as a newcomer.
    await user.type(link, "x");
    expect(shownError()).toBeNull();
  });

  it("marks an over-long draft invalid and points at the count", async () => {
    render(
      <Providers>
        <Editor mode="create" contextTag="work" knownTags={["work"]} busy={false} onSubmit={vi.fn(async () => true)} />
      </Providers>
    );
    const context = document.querySelector(".editor-context-tag")!;
    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(field().getAttribute("aria-describedby")).toBe(context.id);
    fireEvent.change(field(), { target: { value: "x".repeat(40_001) } });
    const count = document.querySelector(".editor-count.is-over")!;
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(field().getAttribute("aria-describedby")?.split(" ")).toEqual([context.id, count.id]);
    fireEvent.change(field(), { target: { value: "short" } });
    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(field().getAttribute("aria-describedby")).toBe(context.id);
  });

  it("says a save conflict once, politely, in its own calm note", () => {
    const message = "This memo changed elsewhere. Your draft is preserved.";
    const view = render(
      <Providers>
        <Editor mode="edit" initialContent="text" knownTags={[]} busy={false} onSubmit={vi.fn(async () => true)} conflictMessage={null} onAcceptRemoteBase={vi.fn()} />
      </Providers>
    );
    view.rerender(
      <Providers>
        <Editor mode="edit" initialContent="text" knownTags={[]} busy={false} onSubmit={vi.fn(async () => true)} conflictMessage={message} onAcceptRemoteBase={vi.fn()} />
      </Providers>
    );
    const note = document.querySelector(".editor-note.is-open .editor-conflict")!;
    expect(note.textContent).toContain(message);
    expect(note.getAttribute("role")).toBeNull();
    expect(spoken("status")).toBe(message);
    expect(spoken("alert")).toBe("");
    // Said once: a later render of the same note does not say it again.
    act(() => {
      document.querySelector(`[${LIVE_REGION_ATTR}] [role="status"]`)!.replaceChildren();
    });
    view.rerender(
      <Providers>
        <Editor mode="edit" initialContent="text " knownTags={[]} busy={false} onSubmit={vi.fn(async () => true)} conflictMessage={message} onAcceptRemoteBase={vi.fn()} />
      </Providers>
    );
    expect(spoken("status")).toBe("");
  });
});

describe("Editor attachment removal under reduced motion", () => {
  it("settles a removal on the dissolve as it does on the exit", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <Editor mode="edit" initialContent="text" existingImages={[stored(0), stored(1)]} knownTags={[]} busy={false} onSubmit={vi.fn(async () => true)} />
      </Providers>
    );
    const tiles = document.querySelectorAll<HTMLElement>(".attachment");
    // A send names each tile after its image (App, landCreated).
    expect([...tiles].map((tile) => tile.dataset.imageId)).toEqual(["stored-0", "stored-1"]);
    const [first] = screen.getAllByRole("button", { name: /^Remove image/ });
    await user.click(first);
    // jsdom has no AnimationEvent, so React listens under the prefixed name.
    const dissolved = new Event("webkitAnimationEnd", { bubbles: true });
    Object.defineProperty(dissolved, "animationName", { value: "attach-dissolve" });
    act(() => {
      first.closest(".attachment")!.dispatchEvent(dissolved);
    });
    expect(screen.getAllByRole("button", { name: /^Remove image/ })).toHaveLength(1);
  });
});

describe("Editor submission state machine, single stop(), and editable landing", () => {
  it("turns Cancel into an enabled Stop button during edit save (even while busy) and aborts on click", async () => {
    const user = userEvent.setup();
    const { onSubmit, calls } = abortableSubmit("resolve-false");
    const onCancel = vi.fn();
    const view = render(
      <Providers>
        <Editor mode="edit" initialContent="before" knownTags={[]} busy={false} onSubmit={onSubmit} onCancel={onCancel} autoFocus />
      </Providers>
    );
    await user.type(field(), " after");
    field().setSelectionRange(1, 5);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    // Simulate App passing busy={savingEdit: true} while the edit save runs.
    view.rerender(
      <Providers>
        <Editor mode="edit" initialContent="before" knownTags={[]} busy={true} onSubmit={onSubmit} onCancel={onCancel} autoFocus />
      </Providers>
    );
    const stop = screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    await user.click(stop);
    expect(calls[0].signal?.aborted).toBe(true);

    view.rerender(
      <Providers>
        <Editor mode="edit" initialContent="before" knownTags={[]} busy={false} onSubmit={onSubmit} onCancel={onCancel} autoFocus />
      </Providers>
    );
    await waitFor(() => expect(field().readOnly).toBe(false));
    expect(screen.getByRole("button", { name: "Cancel" })).not.toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    expect([field().selectionStart, field().selectionEnd]).toEqual([1, 5]);
    expect(document.activeElement).toBe(field());
  });

  it("shows an enabled Stop button during create preparing and stops via button or window Esc", async () => {
    const image = deferred<NewImagePayload>();
    imageMocks.compressImage.mockImplementation(() => image.promise);
    const onSubmit = vi.fn(async () => true);
    const user = userEvent.setup();
    render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={onSubmit} />
      </Providers>
    );
    await user.type(field(), "waiting on photo");
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["a"], "a.png", { type: "image/png" })] } });
    await user.click(screen.getByRole("button", { name: "Send" }));

    const stop = screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    expect(screen.getByText("Preparing image…", { selector: ".editor-status" })).not.toBeNull();
    expect(spoken("status")).toBe("Preparing image…");

    // Clicking Stop exits preparing with smooth leaving classes and prevents auto-submit.
    await user.click(stop);
    expect(stop.classList.contains("is-leaving")).toBe(true);
    expect(document.querySelector(".editor-status")?.classList.contains("is-leaving")).toBe(true);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());

    // Queue again and stop via window Esc even when focus has left the textarea.
    await user.click(screen.getByRole("button", { name: "Send" }));
    const stop2 = screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement;
    stop2.focus();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());

    await act(async () => image.resolve(pendingImage("ready")));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field().value).toBe("waiting on photo");
  });

  it("leaves a queued send alone when the window Esc belongs to a layer or to select mode", async () => {
    const image = deferred<NewImagePayload>();
    imageMocks.compressImage.mockImplementation(() => image.promise);
    const onSubmit = vi.fn(async () => true);
    const user = userEvent.setup();
    render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={onSubmit} />
      </Providers>
    );
    await user.type(field(), "waiting on photo");
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["a"], "a.png", { type: "image/png" })] } });
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("button", { name: "Stop" })).not.toBeNull();

    // A layer is up (the drawer, a menu, the search list): its Esc, not the send's.
    const removeLayer = addLayer(() => undefined);
    fireEvent.keyDown(window, { key: "Escape" });
    removeLayer();
    expect(screen.getByRole("button", { name: "Stop" })).not.toBeNull();

    // Select mode is on: the Esc backs out of it and leaves the send queued.
    const feed = document.createElement("div");
    feed.className = "memo-feed is-select";
    document.body.append(feed);
    fireEvent.keyDown(window, { key: "Escape" });
    feed.remove();
    expect(screen.getByRole("button", { name: "Stop" })).not.toBeNull();

    // With neither, the same Esc stops it.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
    await act(async () => image.resolve(pendingImage("ready")));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("aborts a create send in pre-commit landing on Esc and preserves the draft", async () => {
    const user = userEvent.setup();
    const { onSubmit, calls } = abortableSubmit("resolve-false");
    render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={onSubmit} />
      </Providers>
    );
    await user.type(field(), "abort before land");
    field().setSelectionRange(2, 5);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(field(), { key: "Escape" });
    expect(calls[0].signal?.aborted).toBe(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" }).className).not.toContain("is-sending"));
    expect(field().value).toBe("abort before land");
    expect([field().selectionStart, field().selectionEnd]).toEqual([2, 5]);
    expect(shownError()).toBeNull();
  });

  it("keeps the textarea editable during landing so keystrokes before and after onCommitted survive into the next draft", async () => {
    const user = userEvent.setup();
    const firstLanding = deferred<boolean>();
    let firstCommit: ((animated: boolean) => void) | undefined;
    const calls: EditorSubmission[] = [];
    const onSubmit = vi.fn((data: EditorSubmission) => {
      calls.push(data);
      if (calls.length === 1) {
        firstCommit = data.onCommitted;
        return firstLanding.promise;
      }
      data.onCommitted?.(false);
      return Promise.resolve(true);
    });
    render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={onSubmit} />
      </Providers>
    );

    await user.type(field(), "First memo");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    // Still in `landing`, before onCommitted: textarea stays editable!
    expect(field().readOnly).toBe(false);
    expect(field().closest(".editor")?.getAttribute("aria-busy")).toBe("false");
    await user.type(field(), "Next draft");
    expect(field().value).toBe("Next draft");

    // Previous memo finishes landing and resolves: new draft must survive intact!
    await act(async () => {
      firstCommit?.(true);
      firstLanding.resolve(true);
    });
    expect(field().value).toBe("Next draft");
    expect(calls[0].content).toBe("First memo");

    // Sending the next draft uses a fresh rotated clientId.
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(calls[1].content).toBe("Next draft");
    expect(calls[1].clientId).not.toBe(calls[0].clientId);
  });

  it("preserves Chinese IME text committed after onCommitted fires mid-composition during landing", async () => {
    const landing = deferred<boolean>();
    let commit: ((animated: boolean) => void) | undefined;
    const onSubmit = vi.fn((data: EditorSubmission) => {
      commit = data.onCommitted;
      return landing.promise;
    });
    const user = userEvent.setup();
    render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={onSubmit} />
      </Providers>
    );
    await user.type(field(), "第一条");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    fireEvent.compositionStart(field());
    fireEvent.change(field(), { target: { value: "第一条ni" } });
    // Previous memo commits mid-IME composition: must not wipe while composing.
    act(() => commit?.(true));
    fireEvent.change(field(), { target: { value: "第一条你好" } });
    fireEvent.compositionEnd(field());
    expect(field().value).toBe("你好");

    await act(async () => landing.resolve(true));
    expect(field().value).toBe("你好");
  });

  it("enters edit error phase on save failure, unlocks for retry, and clears error on edit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("Temporary outage"))
      .mockResolvedValueOnce(true);
    render(
      <Providers>
        <Editor mode="edit" initialContent="old" knownTags={[]} busy={false} onSubmit={onSubmit} onCancel={vi.fn()} autoFocus />
      </Providers>
    );
    await user.type(field(), " edit");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(shownError()?.textContent).toBe("Temporary outage"));
    expect(field().readOnly).toBe(false);
    expect(screen.getByRole("button", { name: "Cancel" })).not.toBeNull();

    // Typing clears the edit error phase back to idle.
    await user.type(field(), "!");
    expect(shownError()).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  });

  it("restores focus to the textarea with caret preserved after Keep my draft and continue (click and Enter)", async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn();
    const view = render(
      <Providers>
        <Editor
          mode="edit"
          initialContent="draft text"
          knownTags={[]}
          busy={false}
          onSubmit={vi.fn(async () => true)}
          conflictMessage="This memo changed elsewhere."
          onAcceptRemoteBase={onAccept}
          autoFocus
        />
      </Providers>
    );
    field().setSelectionRange(2, 6);
    const keepButton = screen.getByRole("button", { name: "Keep my draft and continue" });
    // Simulate keyboard navigation onto the conflict button, then pressing Enter.
    keepButton.focus();
    expect(document.activeElement).toBe(keepButton);
    await user.keyboard("{Enter}");
    expect(onAccept).toHaveBeenCalledTimes(1);
    view.rerender(
      <Providers>
        <Editor
          mode="edit"
          initialContent="draft text"
          knownTags={[]}
          busy={false}
          onSubmit={vi.fn(async () => true)}
          conflictMessage={null}
          onAcceptRemoteBase={onAccept}
          autoFocus
        />
      </Providers>
    );
    expect(document.activeElement).toBe(field());
    expect([field().selectionStart, field().selectionEnd]).toEqual([2, 6]);
  });

  it("crossfades the send spinner back into the send glyph and fades the counter out cleanly", async () => {
    const finish = deferred<boolean>();
    const user = userEvent.setup();
    render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={vi.fn(() => finish.promise)} />
      </Providers>
    );
    fireEvent.change(field(), { target: { value: "x".repeat(38_500) } });
    expect(document.querySelector(".editor-count")).not.toBeNull();
    fireEvent.change(field(), { target: { value: "short" } });
    // Counter plays its exit transition instead of hard-cutting.
    const leavingCount = document.querySelector(".editor-count.is-leaving");
    expect(leavingCount).not.toBeNull();
    expect(leavingCount?.getAttribute("aria-hidden")).toBe("true");
    await waitFor(() => expect(document.querySelector(".editor-count")).toBeNull());

    const send = screen.getByRole("button", { name: "Send" });
    await user.click(send);
    await waitFor(() => expect(send.querySelector(".send-icon-slot.is-spinning .send-spinner")).not.toBeNull());
    await act(async () => finish.resolve(true));
    expect(send.querySelector(".send-spinner")).toBeNull();
    expect(send.querySelector(".send-spinner-leaving")).not.toBeNull();
    await waitFor(() => expect(send.querySelector(".send-spinner-leaving")).toBeNull());
  });
});
