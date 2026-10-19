// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor, type EditorSubmission } from "../src/components/Editor";
import { TipProvider } from "../src/components/Tip";
import { LanguageProvider } from "../src/lib/i18n";
import { LIVE_REGION_ATTR, mountLiveRegions } from "../src/lib/liveAnnouncer";
import type { MemoImage, NewImagePayload } from "../src/lib/types";

const mocks = vi.hoisted(() => ({ compressImage: vi.fn() }));

vi.mock("../src/lib/images", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/images")>("../src/lib/images");
  return { ...actual, compressImage: mocks.compressImage };
});

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

/** The complaint on show: the open note's line (spoken through the live
 * region, so the line itself carries no role). Null while none is. */
function shownError(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".editor-note.is-open .editor-error");
}

/** What the standing live region of the given tone is saying. */
function spoken(tone: "status" | "alert"): string {
  return document.querySelector(`[${LIVE_REGION_ATTR}] [role="${tone}"]`)?.textContent ?? "";
}

function pending(id: string): NewImagePayload {
  return { id, dataBase64: "AA==", mime: "image/webp", width: 1, height: 1, previewUrl: `blob:${id}` };
}

function stored(index: number): MemoImage {
  return { id: `stored-${index}`, mime: "image/webp", width: 1, height: 1, bytes: 1 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** A stand-in for the browser's undoable insertText command. */
function installExecCommand() {
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: vi.fn((command: string, _ui: boolean, text?: string) => {
      const area = document.activeElement;
      if (!(area instanceof HTMLTextAreaElement)) return false;
      area.setRangeText(command === "insertText" ? text ?? "" : "", area.selectionStart, area.selectionEnd, "end");
      area.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    })
  });
}

/** A file drag's DataTransfer, as far as the handlers read it. */
function fileDrag(files: File[], types = files.map((file) => file.type)) {
  return {
    dataTransfer: {
      types: ["Files"],
      files,
      items: types.map((type) => ({ kind: "file", type })),
      dropEffect: "none",
      getData: () => ""
    }
  };
}

function setPointer(fine: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion") || (fine && query.includes("pointer: fine")),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  });
}

beforeEach(() => {
  localStorage.clear();
  setPointer(false);
  mocks.compressImage.mockReset();
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
});

afterEach(() => {
  cleanup();
  delete (document as Document & { execCommand?: unknown }).execCommand;
  vi.unstubAllGlobals();
});

function renderCreate(knownTags: string[] = [], onSubmit = vi.fn(async (_data: EditorSubmission) => true)) {
  render(
    <Providers>
      <Editor mode="create" knownTags={knownTags} busy={false} onSubmit={onSubmit} />
    </Providers>
  );
  return { area: field(), onSubmit };
}

describe("Editor tag suggestions follow the caret", () => {
  it("drops a list left behind by caret moves, so Enter breaks the line instead of splicing a tag", async () => {
    const user = userEvent.setup();
    const { area } = renderCreate(["life", "linux"]);
    await user.type(area, "hello ab #li");
    expect(screen.getByRole("listbox", { name: "Tag suggestions" })).not.toBeNull();
    await user.keyboard("{ArrowLeft>6/}");
    expect(area.selectionStart).toBe(6);
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.keyboard("{Enter}");
    expect(area.value).toBe("hello \nab #li");
  });

  it("ignores a stale list even if no select event refreshed it", () => {
    const { area } = renderCreate(["life", "linux"]);
    fireEvent.change(area, { target: { value: "ab #li", selectionStart: 6 } });
    expect(screen.getByRole("listbox")).not.toBeNull();
    // The caret jumps without a select event reaching React.
    area.setSelectionRange(0, 0);
    expect(fireEvent.keyDown(area, { key: "Enter" })).toBe(true);
    expect(area.value).toBe("ab #li");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("completes the whole token under the caret, not just its head", async () => {
    installExecCommand();
    const user = userEvent.setup();
    const { area } = renderCreate(["work", "workshop"]);
    await user.type(area, "#rk");
    await user.keyboard("{ArrowLeft>2/}wo");
    expect(area.value).toBe("#work");
    expect(area.selectionStart).toBe(3);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["#work", "#workshop"]);
    await user.keyboard("{Enter}");
    expect(area.value).toBe("#work ");
    expect(area.selectionStart).toBe(6);
  });

  it("adds no space when the text already goes on with one, or with punctuation", async () => {
    installExecCommand();
    const user = userEvent.setup();
    const { area } = renderCreate(["work", "workshop"]);
    await user.type(area, "#rk next");
    area.setSelectionRange(1, 1);
    await user.keyboard("wo");
    await user.keyboard("{Tab}");
    expect(area.value).toBe("#work next");
    expect(area.selectionStart).toBe(6);
  });

  it("puts no space before punctuation that follows the token", async () => {
    installExecCommand();
    const user = userEvent.setup();
    const { area } = renderCreate(["work", "workshop"]);
    await user.type(area, "#rk, then");
    area.setSelectionRange(1, 1);
    await user.keyboard("wo{Tab}");
    expect(area.value).toBe("#work, then");
    expect(area.selectionStart).toBe(5);
  });

  it("keeps the rest of a Chinese sentence when a tag is completed inside it", async () => {
    installExecCommand();
    const user = userEvent.setup();
    const { area } = renderCreate(["书籍"]);
    await user.type(area, "今天读了很好看的书");
    area.setSelectionRange(4, 4);
    await user.keyboard("#书");
    expect(area.value).toBe("今天读了#书很好看的书");
    await user.keyboard("{Enter}");
    expect(area.value).toBe("今天读了#书籍 很好看的书");
    expect(area.selectionStart).toBe(8);
  });

  it("keeps a word the tag was typed against", async () => {
    installExecCommand();
    const user = userEvent.setup();
    const { area } = renderCreate(["cooking"]);
    await user.type(area, "I love baking");
    area.setSelectionRange(7, 7);
    await user.keyboard("#co{Tab}");
    expect(area.value).toBe("I love #cooking baking");
    expect(area.selectionStart).toBe(16);
  });

  it("still takes in the run after the caret when the tag contains the whole token", async () => {
    installExecCommand();
    const user = userEvent.setup();
    const { area } = renderCreate(["life/cooking"]);
    await user.type(area, "#ok");
    area.setSelectionRange(1, 1);
    await user.keyboard("co{Enter}");
    expect(area.value).toBe("#life/cooking ");
    expect(area.selectionStart).toBe(14);
  });

  it("keeps the list shut while an IME composes, then offers it for the result", () => {
    const { area } = renderCreate(["life"]);
    fireEvent.compositionStart(area);
    fireEvent.change(area, { target: { value: "#", selectionStart: 1 } });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.select(area);
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.compositionEnd(area);
    expect(screen.getByRole("listbox", { name: "Tag suggestions" })).not.toBeNull();
  });

  it("sets the matched run a weight up and keeps a deep tag's leaf whole", async () => {
    const user = userEvent.setup();
    renderCreate(["projects/2026/clients/acme", "acme"]);
    await user.type(field(), "#cm");
    const [deep] = screen.getAllByRole("option");
    expect(deep.querySelector(".tag-suggest-path")?.textContent).toBe("#projects/2026/clients/");
    expect(deep.querySelector(".tag-suggest-leaf")?.textContent).toBe("acme");
    expect([...deep.querySelectorAll(".tag-suggest-hit")].map((hit) => hit.textContent)).toEqual(["cm"]);
  });

  it("lights only one row: the pointer moves the active row, a resting pointer does not", async () => {
    const user = userEvent.setup();
    const { area } = renderCreate(["alpha", "beta", "gamma"]);
    await user.type(area, "#");
    const options = () => screen.getAllByRole("option");
    act(() => {
      options()[2].dispatchEvent(new MouseEvent("mousemove", { bubbles: true, movementY: 4 } as MouseEventInit));
    });
    expect(options()[2].getAttribute("aria-selected")).toBe("true");
    expect(area.getAttribute("aria-activedescendant")).toBe(options()[2].id);
    // A list redrawn under a still pointer reports no movement.
    await user.keyboard("{ArrowUp}");
    act(() => {
      options()[2].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    expect(options()[1].getAttribute("aria-selected")).toBe("true");
    expect(document.querySelectorAll(".tag-suggest .is-active")).toHaveLength(1);
  });

  it("sends on ⌘↩ with the list open instead of taking the highlighted tag", async () => {
    const user = userEvent.setup();
    const { area, onSubmit } = renderCreate(["life", "linux"]);
    await user.type(area, "note #li");
    expect(screen.getByRole("listbox", { name: "Tag suggestions" })).not.toBeNull();
    fireEvent.keyDown(area, { key: "Enter", metaKey: true });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].content).toBe("note #li");
  });

  it("opens only where a tag can start: not inside a word, a number or a link", async () => {
    const user = userEvent.setup();
    const { area } = renderCreate(["csharp", "section"]);
    for (const text of ["C#", "page#se", "2#", "https://x.com/#se"]) {
      await user.clear(area);
      await user.type(area, text);
      expect(screen.queryByRole("listbox")).toBeNull();
    }
    // Space, punctuation (CJK too) or Chinese running straight into the tag.
    for (const text of ["#se", "(#se", "a，#se", "今天#se"]) {
      await user.clear(area);
      await user.type(area, text);
      expect(screen.getByRole("listbox", { name: "Tag suggestions" })).not.toBeNull();
    }
  });

  it("lets Enter break the line after a bare #, while Tab, or ↓ then Enter, take a tag", async () => {
    installExecCommand();
    const user = userEvent.setup();
    const { area } = renderCreate(["recent", "older"]);
    await user.type(area, "#");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["#recent", "#older"]);
    await user.keyboard("{Enter}");
    expect(area.value).toBe("#\n");
    expect(screen.queryByRole("listbox")).toBeNull();

    await user.type(area, "#");
    await user.keyboard("{Tab}");
    expect(area.value).toBe("#\n#recent ");

    await user.type(area, "#");
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(area.value).toBe("#\n#recent #older ");
  });

  it("offers a bare # the five tags used last, in the order they arrive", async () => {
    const user = userEvent.setup();
    renderCreate(["f", "e", "d", "c", "b", "a"]);
    await user.type(field(), "#");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["#f", "#e", "#d", "#c", "#b"]);
  });

  it("offers guesses under an overline, and says a new tag is coming when nothing matches", async () => {
    const user = userEvent.setup();
    const { area } = renderCreate(["work/today", "travel"]);
    await user.type(area, "#wkt");
    const group = screen.getByRole("group", { name: "Did you mean" });
    const [guess] = within(group).getAllByRole("option");
    expect(guess.textContent).toBe("#work/today");
    expect([...guess.querySelectorAll(".tag-suggest-hit")].map((hit) => hit.textContent)).toEqual(["w", "k", "t"]);

    await user.type(area, "zz");
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByRole("listbox").textContent).toBe("Keep typing to create #wktzz");
    expect(screen.getByRole("option").getAttribute("aria-disabled")).toBe("true");
    expect(area.hasAttribute("aria-activedescendant")).toBe(false);
    // Nothing to take: Enter is a new line.
    await user.keyboard("{Enter}");
    expect(area.value).toBe("#wktzz\n");
  });

  it("breaks the line on Shift+↩ and leaves Shift+Tab its own job, closing the list either way", async () => {
    const user = userEvent.setup();
    const { area } = renderCreate(["life", "linux"]);
    await user.type(area, "note #li");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(area.value).toBe("note #li\n");
    expect(screen.queryByRole("listbox")).toBeNull();

    await user.keyboard("{Backspace}");
    expect(screen.getByRole("listbox")).not.toBeNull();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(area.value).toBe("note #li");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("Editor file drops", () => {
  it("claims a file dropped anywhere in the window for the composer, lighting its veil meanwhile", async () => {
    mocks.compressImage.mockResolvedValue(pending("stray"));
    renderCreate();
    const editor = document.querySelector(".editor")!;
    const photo = new File(["a"], "a.png", { type: "image/png" });

    fireEvent.dragEnter(document.body, fileDrag([photo]));
    expect(editor.classList.contains("is-dropping")).toBe(true);
    expect(screen.getByText("Drop here to add images")).not.toBeNull();
    // The browser's default (opening the file in the tab) is cancelled.
    expect(fireEvent.dragOver(document.body, fileDrag([photo]))).toBe(false);
    expect(fireEvent.drop(document.body, fileDrag([photo]))).toBe(false);
    expect(editor.classList.contains("is-dropping")).toBe(false);
    await screen.findByRole("button", { name: "Remove image" });
    expect(mocks.compressImage).toHaveBeenCalledWith(photo);
  });

  it("routes a stray drop to the open inline edit before the composer", async () => {
    mocks.compressImage.mockResolvedValue(pending("edit"));
    render(
      <Providers>
        <div className="composer">
          <Editor mode="create" knownTags={[]} busy={false} onSubmit={vi.fn(async () => true)} />
        </div>
        <Editor mode="edit" initialContent="memo" knownTags={[]} busy={false} onSubmit={vi.fn(async () => true)} onCancel={vi.fn()} />
      </Providers>
    );
    const photo = new File(["a"], "a.png", { type: "image/png" });
    fireEvent.dragEnter(document.body, fileDrag([photo]));
    expect(document.querySelector(".editor-edit")?.classList.contains("is-dropping")).toBe(true);
    expect(document.querySelector(".editor-create")?.classList.contains("is-dropping")).toBe(false);
    fireEvent.drop(document.body, fileDrag([photo]));
    await waitFor(() => expect(document.querySelectorAll(".editor-edit .attachment img")).toHaveLength(1));
    expect(document.querySelectorAll(".editor-create .attachment")).toHaveLength(0);
  });

  it("leaves a hidden composer out, but still keeps the file from opening", () => {
    render(
      <Providers>
        <div className="composer" hidden>
          <Editor mode="create" knownTags={[]} busy={false} onSubmit={vi.fn(async () => true)} />
        </div>
      </Providers>
    );
    const photo = new File(["a"], "a.png", { type: "image/png" });
    fireEvent.dragEnter(document.body, fileDrag([photo]));
    expect(document.querySelector(".editor")?.classList.contains("is-dropping")).toBe(false);
    const over = fileDrag([photo]);
    expect(fireEvent.dragOver(document.body, over)).toBe(false);
    expect(over.dataTransfer.dropEffect).toBe("none");
    expect(fireEvent.drop(document.body, fileDrag([photo]))).toBe(false);
    expect(mocks.compressImage).not.toHaveBeenCalled();
  });

  it("stops guarding once no editor is left", () => {
    renderCreate();
    cleanup();
    const photo = new File(["a"], "a.png", { type: "image/png" });
    expect(fireEvent.dragOver(document.body, fileDrag([photo]))).toBe(true);
  });

  it("says why a drag would add nothing: not an image, or no room left", () => {
    const { area } = renderCreate();
    const editor = area.closest(".editor")!;
    const pdf = new File(["%PDF"], "a.pdf", { type: "application/pdf" });
    fireEvent.dragEnter(editor, fileDrag([pdf]));
    expect(screen.getByText("Only images can be added")).not.toBeNull();
    expect(editor.querySelector(".editor-drop")?.classList.contains("is-refusing")).toBe(true);
    const over = fileDrag([pdf]);
    fireEvent.dragOver(editor, over);
    expect(over.dataTransfer.dropEffect).toBe("none");
    expect(fireEvent.drop(editor, fileDrag([pdf]))).toBe(false);
    expect(shownError()?.textContent).toBe("Only images can be added");
    cleanup();

    render(
      <Providers>
        <Editor
          mode="edit"
          initialContent="full"
          existingImages={Array.from({ length: 9 }, (_, index) => stored(index))}
          knownTags={[]}
          busy={false}
          onSubmit={vi.fn(async () => true)}
          onCancel={vi.fn()}
        />
      </Providers>
    );
    const full = document.querySelector(".editor")!;
    fireEvent.dragEnter(full, fileDrag([new File(["a"], "a.png", { type: "image/png" })]));
    expect(full.querySelector(".editor-drop")?.textContent).toBe("You can add up to 9 images");
  });
});

describe("Editor send", () => {
  it("stays lifted while sending and fades the spinner in only for a slow send", async () => {
    const finish = deferred<boolean>();
    const user = userEvent.setup();
    const { area } = renderCreate([], vi.fn(() => finish.promise));
    await user.type(area, "note");
    const send = screen.getByRole("button", { name: "Send" });
    await user.click(send);
    expect(send.className).toContain("is-sending");
    expect(send.querySelector(".send-spinner")).toBeNull();
    await waitFor(() => expect(send.querySelector(".send-spinner")).not.toBeNull());
    await act(async () => finish.resolve(true));
    expect(send.className).not.toContain("is-sending");
    expect(send.querySelector(".send-spinner")).toBeNull();
  });

  it("clears the composer inside the owner's landing update, then keeps the caret in it on a fine pointer", async () => {
    setPointer(true);
    const user = userEvent.setup();
    let valueAfterLanding: string | null = null;
    const onSubmit = vi.fn(async (data: EditorSubmission) => {
      flushSync(() => data.onCommitted?.(true));
      valueAfterLanding = field().value;
      return true;
    });
    const { area } = renderCreate([], onSubmit);
    await user.type(area, "note");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(valueAfterLanding).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(area));
  });

  it("flies the send glyph off and back once a send empties the composer", async () => {
    const user = userEvent.setup();
    const { area } = renderCreate();
    expect(document.querySelector(".send-glyph")?.classList.contains("is-flying")).toBe(false);
    await user.type(area, "note");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(area.value).toBe(""));
    const glyph = document.querySelector(".send-glyph")!;
    expect(glyph.classList.contains("is-flying")).toBe(true);
    finishAnimation(glyph, "send-glyph-fly");
    expect(document.querySelector(".send-glyph")?.classList.contains("is-flying")).toBe(false);
  });

  it("accepts Send while an image compresses and sends once it lands", async () => {
    const image = deferred<NewImagePayload>();
    mocks.compressImage.mockImplementation(() => image.promise);
    const user = userEvent.setup();
    const { area, onSubmit } = renderCreate();
    await user.type(area, "with a photo");
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["a"], "a.png", { type: "image/png" })] } });
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await user.click(send);
    expect(screen.getByText("Preparing image…")).not.toBeNull();
    expect(send.className).toContain("is-sending");
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => image.resolve(pending("late")));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].newImages.map((item) => item.id)).toEqual(["late"]);
    expect(onSubmit.mock.calls[0][0].content).toBe("with a photo");
    await waitFor(() => expect(screen.queryByText("Preparing image…")).toBeNull());
  });

  it("drops the held send when the image fails, and says so", async () => {
    const image = deferred<NewImagePayload>();
    mocks.compressImage.mockImplementation(() => image.promise);
    const user = userEvent.setup();
    const { area, onSubmit } = renderCreate();
    await user.type(area, "with a photo");
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["a"], "a.png", { type: "image/png" })] } });
    await user.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => image.reject(new Error("Decoder gave up")));
    // The complaint names the file it is about.
    await waitFor(() => expect(shownError()?.textContent).toBe("a.png: Decoder gave up"));
    expect(screen.queryByText("Preparing image…")).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(area.value).toBe("with a photo");
  });
});

describe("Editor edit state", () => {
  function renderEdit(onCancel = vi.fn(), onSubmit = vi.fn(async () => true), existingImages: MemoImage[] = []) {
    render(
      <Providers>
        <Editor
          mode="edit"
          initialContent="original"
          existingImages={existingImages}
          knownTags={[]}
          busy={false}
          onSubmit={onSubmit}
          onCancel={onCancel}
          autoFocus
        />
      </Providers>
    );
    return { area: field(), onCancel, onSubmit };
  }

  it("keeps Save at rest until something changed, and closes a clean edit on ⌘↩", async () => {
    const user = userEvent.setup();
    const { area, onCancel, onSubmit } = renderEdit();
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.keyDown(area, { key: "Enter", metaKey: true });
    expect(onCancel).toHaveBeenCalledWith(null);
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(area, "!");
    expect(save.disabled).toBe(false);
    await user.type(area, "{Backspace}");
    expect(save.disabled).toBe(true);
  });

  it("peels Esc one layer at a time: the link row before the edit itself", async () => {
    const user = userEvent.setup();
    const { area, onCancel } = renderEdit();
    await user.type(area, " changed");
    await user.click(screen.getByRole("button", { name: "Insert image link" }));
    area.focus();
    fireEvent.keyDown(area, { key: "Escape" });
    expect(document.querySelector(".link-pop")?.classList.contains("is-open")).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(area, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel.mock.calls[0][0]?.content).toBe("original changed");
  });

  it("clears an error once its cause is gone", async () => {
    const user = userEvent.setup();
    mocks.compressImage.mockResolvedValue(pending("tenth"));
    renderEdit(vi.fn(), vi.fn(async () => true), Array.from({ length: 9 }, (_, index) => stored(index)));

    await user.click(screen.getByRole("button", { name: "Insert image link" }));
    const link = document.querySelector(".link-pop-inner input") as HTMLInputElement;
    await user.type(link, "not a url{Enter}");
    expect(shownError()?.textContent).toBe("Enter an image URL beginning with http(s)://");
    fireEvent.keyDown(link, { key: "Escape" });
    expect(shownError()).toBeNull();

    fireEvent.drop(document.querySelector(".editor")!, fileDrag([new File(["a"], "a.png", { type: "image/png" })]));
    await waitFor(() => expect(shownError()?.textContent).toBe("You can add up to 9 images"));
    const [first] = screen.getAllByRole("button", { name: /^Remove image/ });
    await user.click(first);
    // jsdom has no AnimationEvent, so React listens under the prefixed name.
    const exited = new Event("webkitAnimationEnd", { bubbles: true });
    Object.defineProperty(exited, "animationName", { value: "attach-out" });
    act(() => {
      first.closest(".attachment")!.dispatchEvent(exited);
    });
    expect(screen.getAllByRole("button", { name: /^Remove image/ })).toHaveLength(8);
    expect(shownError()).toBeNull();
  });

  it("lets the composer go on Esc", async () => {
    const user = userEvent.setup();
    const { area } = renderCreate();
    await user.click(area);
    fireEvent.keyDown(area, { key: "Escape" });
    expect(document.activeElement).not.toBe(area);
  });
});

describe("Editor list keys", () => {
  it("takes an empty item's marker on Backspace and indents every selected line on Tab, undoably", async () => {
    installExecCommand();
    const user = userEvent.setup();
    const { area } = renderCreate();
    await user.type(area, "- milk{Enter}");
    expect(area.value).toBe("- milk\n- ");
    await user.keyboard("{Backspace}");
    expect(area.value).toBe("- milk\n");
    expect(document.execCommand).toHaveBeenLastCalledWith("delete", false, "");

    fireEvent.change(area, { target: { value: "- a\n- b\n- c" } });
    area.setSelectionRange(0, area.value.length);
    fireEvent.keyDown(area, { key: "Tab" });
    expect(area.value).toBe("  - a\n  - b\n  - c");
    expect(area.value.slice(area.selectionStart, area.selectionEnd)).toBe("  - a\n  - b\n  - c");
  });
});

describe("Editor autogrow", () => {
  it("grows from the height on screen, so the height transition has a start", async () => {
    const user = userEvent.setup();
    const { area } = renderCreate();
    let onScreen = 68;
    let text = 68;
    const writes: string[] = [];
    const style = area.style;
    Object.defineProperty(area, "offsetHeight", { configurable: true, get: () => onScreen });
    Object.defineProperty(area, "scrollHeight", { configurable: true, get: () => text });
    Object.defineProperty(style, "height", {
      configurable: true,
      get: () => writes[writes.length - 1] ?? "68px",
      set: (value: string) => {
        writes.push(value);
      }
    });
    text = 104;
    await user.type(area, "a");
    expect(writes).toEqual(["auto", "68px", "104px"]);
    onScreen = 104;
    writes.length = 0;
    await user.type(area, "b");
    // Same height: no detour back through a start value.
    expect(writes).toEqual(["auto", "104px"]);
  });

  it("stops short of an open on-screen keyboard, counted from where the field starts", async () => {
    const user = userEvent.setup();
    const { area } = renderCreate();
    vi.stubGlobal("innerHeight", 844);
    vi.stubGlobal("visualViewport", { height: 380, offsetTop: 0, scale: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    Object.defineProperty(area, "scrollHeight", { configurable: true, get: () => 900 });
    area.getBoundingClientRect = () => ({ top: 100, bottom: 168 }) as DOMRect;
    // The bar and padding take 56px under the field.
    (area.closest(".editor") as HTMLElement).getBoundingClientRect = () => ({ top: 86, bottom: 224 }) as DOMRect;
    await user.type(area, "a");
    // 380 − 100 − 56 − 8 keeps Send above the keys; 70% of 380 (266) would not.
    expect(area.style.height).toBe("216px");
  });
});

/** Finish a CSS animation jsdom never runs (React listens under the prefixed name). */
function finishAnimation(element: Element, animationName: string) {
  const ended = new Event("webkitAnimationEnd", { bubbles: true });
  Object.defineProperty(ended, "animationName", { value: animationName });
  act(() => {
    element.dispatchEvent(ended);
  });
}

describe("Editor tag list motion", () => {
  it("steps aside while an IME composes and comes back as the same list, without a second entrance", () => {
    const { area } = renderCreate(["读书笔记", "读书"]);
    fireEvent.change(area, { target: { value: "#读", selectionStart: 2 } });
    const list = screen.getByRole("listbox", { name: "Tag suggestions" });
    fireEvent.compositionStart(area);
    fireEvent.change(area, { target: { value: "#读shu", selectionStart: 5 } });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(list.isConnected).toBe(true);
    expect(list.classList.contains("is-paused")).toBe(true);
    expect(area.getAttribute("aria-expanded")).toBe("false");
    fireEvent.change(area, { target: { value: "#读书", selectionStart: 3 } });
    fireEvent.compositionEnd(area);
    expect(screen.getByRole("listbox")).toBe(list);
    expect(list.className).toBe("tag-suggest");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["#读书笔记"]);
  });

  it("plays the menus' exit before it leaves", async () => {
    const user = userEvent.setup();
    const { area } = renderCreate(["life"]);
    await user.type(area, "#li");
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(area, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(list.classList.contains("is-closing")).toBe(true);
    finishAnimation(list, "menu-out");
    expect(list.isConnected).toBe(false);
  });

  it("leaves on the reduced-motion dissolve too", async () => {
    const user = userEvent.setup();
    const { area } = renderCreate(["life"]);
    await user.type(area, "#li");
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(area, { key: "Escape" });
    expect(list.classList.contains("is-closing")).toBe(true);
    finishAnimation(list, "fade-out");
    expect(list.isConnected).toBe(false);
  });
});

describe("Editor paste with a picture beside the words", () => {
  function clip(data: Record<string, string>, files: File[]) {
    return {
      clipboardData: {
        items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
        types: [...Object.keys(data), ...(files.length > 0 ? ["Files"] : [])],
        getData: (type: string) => data[type] ?? ""
      }
    };
  }
  const picture = (name = "image.png") => new File(["png"], name, { type: "image/png" });

  it("pastes copied cells as a table, not the picture Excel puts beside them", async () => {
    installExecCommand();
    const { area } = renderCreate();
    area.focus();
    const cells = clip(
      { "text/plain": "Q1\t12\nQ2\t15", "text/html": "<table><tr><td>Q1</td><td>12</td></tr><tr><td>Q2</td><td>15</td></tr></table>" },
      [picture()]
    );
    expect(fireEvent.paste(area, cells)).toBe(false);
    await waitFor(() => expect(area.value).toBe("| Q1 | 12 |\n| --- | --- |\n| Q2 | 15 |"));
    expect(mocks.compressImage).not.toHaveBeenCalled();
  });

  it("still adds a picture pasted alone, from a browser's Copy image, or as a copied file", async () => {
    let n = 0;
    mocks.compressImage.mockImplementation(async () => pending(`pic-${++n}`));
    const { area } = renderCreate();
    fireEvent.paste(area, clip({}, [picture()]));
    fireEvent.paste(area, clip({ "text/html": '<meta charset="utf-8"><img src="https://e.com/a.png">' }, [picture()]));
    fireEvent.paste(area, clip({ "text/plain": "Screenshot 2026-10-13.png" }, [picture("Screenshot 2026-10-13.png")]));
    await waitFor(() => expect(mocks.compressImage).toHaveBeenCalledTimes(3));
    expect(area.value).toBe("");
  });
});

describe("Editor notes", () => {
  it("lets a refused file's complaint go once the text moves on, folding on its last words", async () => {
    const user = userEvent.setup();
    const { area } = renderCreate();
    fireEvent.drop(area.closest(".editor")!, fileDrag([new File(["%PDF"], "a.pdf", { type: "application/pdf" })]));
    expect(shownError()?.textContent).toBe("Only images can be added");
    await user.type(area, "x");
    expect(shownError()).toBeNull();
    expect(document.querySelector(".editor-note:not(.is-open) .editor-error")?.textContent).toBe("Only images can be added");
  });

  it("keeps the caret in the field through a failed send, and says a second failure again", async () => {
    const unmountRegions = mountLiveRegions();
    setPointer(true);
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (_data: EditorSubmission): Promise<boolean> => {
      throw new Error("Server hiccup");
    });
    const { area } = renderCreate([], onSubmit);
    await user.type(area, "note");
    const sendButton = screen.getByRole("button", { name: "Send" });
    // A mouse press on Send leaves the caret where it was.
    expect(fireEvent.mouseDown(sendButton)).toBe(false);
    await user.click(sendButton);
    await waitFor(() => expect(shownError()?.textContent).toBe("Server hiccup"));
    const first = shownError();
    // Said through the standing region, not by a freshly mounted alert.
    expect(first?.getAttribute("role")).toBeNull();
    expect(spoken("alert")).toBe("Server hiccup");
    expect(document.activeElement).toBe(area);
    await user.click(sendButton);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(shownError()).not.toBe(first));
    expect(spoken("alert")).toBe("Server hiccup");
    unmountRegions();
  });

  it("lets a tap on Send take focus, so a phone's keyboard can go", () => {
    renderCreate();
    expect(fireEvent.mouseDown(screen.getByRole("button", { name: "Send" }))).toBe(true);
  });

  it("names the wrap shortcuts that have no button of their own", () => {
    const { area } = renderCreate();
    const keys = area.getAttribute("aria-keyshortcuts") ?? "";
    for (const key of ["Meta+I", "Control+E", "Meta+Shift+S", "Control+Shift+H", "Meta+K"]) expect(keys).toContain(key);
  });
});

describe("Editor toolbar and shortcuts", () => {
  it("links the selection on ⌘K and keeps the page's own ⌘K from hearing it", async () => {
    installExecCommand();
    const user = userEvent.setup();
    const { area } = renderCreate();
    await user.type(area, "see the docs");
    area.setSelectionRange(4, 12);
    const pageKeys = vi.fn();
    window.addEventListener("keydown", pageKeys);
    fireEvent.keyDown(area, { key: "k", metaKey: true });
    window.removeEventListener("keydown", pageKeys);
    expect(area.value).toBe("see [the docs](url)");
    expect(area.value.slice(area.selectionStart, area.selectionEnd)).toBe("url");
    expect(pageKeys).not.toHaveBeenCalled();
  });

  it("shows Bold and List pressed where the caret already is in bold text or on a list line", async () => {
    const user = userEvent.setup();
    const { area } = renderCreate();
    await user.type(area, "- a **bold** word");
    const bold = screen.getByRole("button", { name: "Bold" });
    const list = screen.getByRole("button", { name: "Bullet list" });
    expect(list.getAttribute("aria-pressed")).toBe("true");
    expect(bold.getAttribute("aria-pressed")).toBe("false");
    area.setSelectionRange(8, 8);
    fireEvent.select(area);
    expect(bold.getAttribute("aria-pressed")).toBe("true");
    expect(bold.className).toContain("is-active-tool");
  });

  it("is one Tab stop, ←/→ moving along it, and says whether the link row is open", async () => {
    const user = userEvent.setup();
    renderCreate();
    const toolbar = screen.getByRole("toolbar", { name: "Writing tools" });
    const tools = within(toolbar).getAllByRole("button");
    expect(tools.filter((tool) => tool.tabIndex === 0)).toEqual([tools[0]]);
    act(() => tools[0].focus());
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tools[1]);
    expect(tools.filter((tool) => tool.tabIndex === 0)).toEqual([tools[1]]);
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(document.activeElement).toBe(tools[tools.length - 1]);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(tools[0]);

    const link = within(toolbar).getByRole("button", { name: "Insert image link" });
    expect(link.getAttribute("aria-expanded")).toBe("false");
    await user.click(link);
    expect(link.getAttribute("aria-expanded")).toBe("true");
    expect(link.getAttribute("aria-controls")).toBe(document.querySelector(".link-pop")?.id);
  });
});

describe("Editor attachment tiles", () => {
  const previews = () => [...document.querySelectorAll(".attachment:not(.is-removing) img")].map((img) => img.getAttribute("src"));

  function addFiles(count: number) {
    const files = Array.from({ length: count }, (_, index) => new File(["a"], `${index}.png`, { type: "image/png" }));
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files } });
  }

  it("keeps one tile per image from compressing to ready, and says when it lands", async () => {
    const unmountRegions = mountLiveRegions();
    const image = deferred<NewImagePayload>();
    mocks.compressImage.mockImplementation(() => image.promise);
    renderCreate();
    addFiles(1);
    const tile = await screen.findByRole("img", { name: "Compressing image" });
    await act(async () => image.resolve(pending("ready")));
    expect(screen.getByRole("button", { name: "Remove image" }).closest(".attachment")).toBe(tile);
    expect(tile.classList.contains("is-busy")).toBe(false);
    expect(document.querySelector(`[${LIVE_REGION_ATTR}]`)?.textContent).toContain("Added the image");
    unmountRegions();
  });

  it("numbers the × like the card's images and hands focus on when one goes", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <Editor
          mode="edit"
          initialContent="memo"
          existingImages={[stored(1), stored(2), stored(3)]}
          knownTags={[]}
          busy={false}
          onSubmit={vi.fn(async () => true)}
          onCancel={vi.fn()}
        />
      </Providers>
    );
    const buttons = screen.getAllByRole("button", { name: /^Remove image/ });
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Remove image 1 of 3", "Remove image 2 of 3", "Remove image 3 of 3"]);
    // The memo's own images are on screen already: they do not pop in again.
    expect([...document.querySelectorAll(".attachment")].every((tile) => tile.classList.contains("is-settled"))).toBe(true);
    buttons[1].focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(buttons[2]);
    expect(screen.getAllByRole("button", { name: /^Remove image/ }).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Remove image 1 of 2",
      "Remove image 2 of 2"
    ]);
  });

  it("keeps the caret in the field when a tile's × is clicked", async () => {
    const user = userEvent.setup();
    mocks.compressImage.mockImplementation(async () => pending("p1"));
    const { area } = renderCreate();
    addFiles(1);
    const remove = await screen.findByRole("button", { name: "Remove image" });
    await user.click(area);
    await user.click(remove);
    expect(remove.closest(".attachment")?.classList.contains("is-removing")).toBe(true);
    expect(document.activeElement).toBe(area);
  });

  it("offers Undo for a removed image and puts it back in the slot it left", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    let n = 0;
    mocks.compressImage.mockImplementation(async () => pending(`p${++n}`));
    render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={vi.fn(async () => true)} onNotice={onNotice} />
      </Providers>
    );
    addFiles(3);
    await waitFor(() => expect(previews()).toEqual(["blob:p1", "blob:p2", "blob:p3"]));
    const second = screen.getByRole("button", { name: "Remove image 2 of 3" });
    await user.click(second);
    finishAnimation(second.closest(".attachment")!, "attach-out");
    expect(previews()).toEqual(["blob:p1", "blob:p3"]);
    expect(onNotice).toHaveBeenCalledWith("Removed the image", expect.objectContaining({ label: "Undo" }));
    // Held for the Undo, not released yet.
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:p2");
    act(() => onNotice.mock.calls[0][1].run());
    expect(previews()).toEqual(["blob:p1", "blob:p2", "blob:p3"]);
  });

  it("spends no Undo on the next memo once the draft is sent", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    mocks.compressImage.mockImplementation(async () => pending("gone"));
    const { area } = (() => {
      render(
        <Providers>
          <Editor mode="create" knownTags={[]} busy={false} onSubmit={vi.fn(async () => true)} onNotice={onNotice} />
        </Providers>
      );
      return { area: field() };
    })();
    addFiles(1);
    const remove = await screen.findByRole("button", { name: "Remove image" });
    await user.click(remove);
    finishAnimation(remove.closest(".attachment")!, "attach-out");
    await user.type(area, "words");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(area.value).toBe(""));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:gone");
    act(() => onNotice.mock.calls[0][1].run());
    expect(previews()).toEqual([]);
  });

  it("brings a removed image of the memo itself back through Undo", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    const onSubmit = vi.fn(async (_data: EditorSubmission) => true);
    render(
      <Providers>
        <Editor
          mode="edit"
          initialContent="memo"
          existingImages={[stored(1), stored(2)]}
          knownTags={[]}
          busy={false}
          onSubmit={onSubmit}
          onCancel={vi.fn()}
          onNotice={onNotice}
        />
      </Providers>
    );
    const first = screen.getByRole("button", { name: "Remove image 1 of 2" });
    await user.click(first);
    finishAnimation(first.closest(".attachment")!, "attach-out");
    expect(screen.getAllByRole("button", { name: /^Remove image/ })).toHaveLength(1);
    act(() => onNotice.mock.calls[0][1].run());
    expect(screen.getAllByRole("button", { name: /^Remove image/ })).toHaveLength(2);
    // Back to how it opened: nothing to save.
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens a tile in the viewer, an image not yet sent by its preview", async () => {
    const user = userEvent.setup();
    const onOpenImage = vi.fn();
    mocks.compressImage.mockImplementation(async () => pending("p1"));
    render(
      <Providers>
        <Editor
          mode="edit"
          initialContent="memo"
          existingImages={[stored(1)]}
          knownTags={[]}
          busy={false}
          onSubmit={vi.fn(async () => true)}
          onCancel={vi.fn()}
          onOpenImage={onOpenImage}
        />
      </Providers>
    );
    addFiles(1);
    await user.click(await screen.findByRole("button", { name: "View image 2 of 2" }));
    expect(onOpenImage).toHaveBeenCalledWith([{ src: "/api/images/stored-1", imageId: "stored-1" }, { src: "blob:p1" }], 1);
  });

  it("moves an image not yet sent with Alt+←/→, says where it now is, and sends that order", async () => {
    const unmountRegions = mountLiveRegions();
    const user = userEvent.setup();
    let n = 0;
    mocks.compressImage.mockImplementation(async () => pending(`p${++n}`));
    const { area, onSubmit } = renderCreate();
    addFiles(3);
    await waitFor(() => expect(previews()).toEqual(["blob:p1", "blob:p2", "blob:p3"]));
    act(() => screen.getByRole("button", { name: "Image 1 of 3" }).focus());
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(previews()).toEqual(["blob:p2", "blob:p1", "blob:p3"]);
    // Focus rides along with the moved tile.
    expect(document.activeElement?.closest(".attachment")?.getAttribute("data-image-id")).toBe("p1");
    expect(spoken("status")).toBe("Image 2 of 3");
    await user.type(area, "three photos");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].newImages.map((image) => image.id)).toEqual(["p2", "p1", "p3"]);
    unmountRegions();
  });

  it("drags a tile to a new place, showing the slot it would land in", async () => {
    let n = 0;
    mocks.compressImage.mockImplementation(async () => pending(`p${++n}`));
    renderCreate();
    addFiles(3);
    await waitFor(() => expect(previews()).toEqual(["blob:p1", "blob:p2", "blob:p3"]));
    // Tiles 64px wide, 8px apart, in one row at the row's origin.
    const rects = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("attachment")) {
        const at = [...document.querySelectorAll(".attachment")].indexOf(this);
        return new DOMRect(at * 72, 0, 64, 64);
      }
      return new DOMRect(0, 0, 0, 0);
    });
    try {
      const handle = screen.getByRole("button", { name: "Image 1 of 3" });
      fireEvent.pointerDown(handle, { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, clientX: 32, clientY: 32 });
      fireEvent.pointerMove(handle, { pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: 190, clientY: 32 });
      expect(handle.closest(".attachment")?.classList.contains("is-lifted")).toBe(true);
      // Past the last tile's middle: the bar stands after it.
      expect((document.querySelector(".attachment-slot") as HTMLElement | null)?.style.left).toBe(`${2 * 72 + 64 + 3}px`);
      fireEvent.pointerUp(handle, { pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: 190, clientY: 32 });
      expect(previews()).toEqual(["blob:p2", "blob:p3", "blob:p1"]);
      expect(document.querySelector(".attachment-slot")).toBeNull();
      expect(document.querySelector(".is-lifted")).toBeNull();
    } finally {
      rects.mockRestore();
    }
  });

  it("keeps a tile that could not be made for a moment, marked, and names the file", async () => {
    vi.useFakeTimers();
    try {
      mocks.compressImage.mockRejectedValue(new Error("Unable to read image"));
      renderCreate();
      fireEvent.change(document.querySelector('input[type="file"]')!, {
        target: { files: [new File(["a"], "IMG_2041.HEIC", { type: "image/heic" })] }
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(document.querySelector(".attachment.is-failed")).not.toBeNull();
      expect(shownError()?.textContent).toBe("IMG_2041.HEIC: this browser can’t read HEIC — export it as JPG first");
      // It holds no place: another image can come in at once.
      expect((screen.getByRole("button", { name: "Add image" }) as HTMLButtonElement).disabled).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(document.querySelector(".attachment.is-failed")?.classList.contains("is-leaving")).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(document.querySelector(".attachment")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
