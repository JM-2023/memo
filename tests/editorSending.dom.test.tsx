// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor, type EditorSubmission } from "../src/components/Editor";
import { TipProvider } from "../src/components/Tip";
import { LanguageProvider } from "../src/lib/i18n";
import { LIVE_REGION_ATTR, mountLiveRegions } from "../src/lib/liveAnnouncer";
import type { MemoImage } from "../src/lib/types";

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

describe("Editor in-flight send", () => {
  it("stops a send in flight on Esc and hands the field back as it was", async () => {
    const user = userEvent.setup();
    const { onSubmit, calls } = abortableSubmit("resolve-false");
    render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={onSubmit} />
      </Providers>
    );
    await user.type(field(), "half a thought");
    field().setSelectionRange(2, 6);
    await user.click(screen.getByRole("button", { name: "Send" }));
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
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={onSubmit} />
      </Providers>
    );
    await user.type(field(), "draft");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(field(), { key: "Escape" });
    await waitFor(() => expect(field().readOnly).toBe(false));
    expect(calls[0].signal?.aborted).toBe(true);
    expect(field().value).toBe("draft");
    expect(shownError()).toBeNull();
    expect(spoken("alert")).toBe("");
    // The same draft goes again under the same id, so a request that got
    // through after all is found rather than doubled.
    await user.click(screen.getByRole("button", { name: "Send" }));
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
