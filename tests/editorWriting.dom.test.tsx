// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor, type EditorSubmission } from "../src/components/Editor";
import { TipProvider } from "../src/components/Tip";
import { LanguageProvider } from "../src/lib/i18n";
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
    expect(screen.getByRole("alert").textContent).toBe("Only images can be added");
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
    expect((await screen.findByRole("alert")).textContent).toBe("Decoder gave up");
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
    expect(screen.getByRole("alert").textContent).toBe("Enter an image URL beginning with http(s)://");
    fireEvent.keyDown(link, { key: "Escape" });
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.drop(document.querySelector(".editor")!, fileDrag([new File(["a"], "a.png", { type: "image/png" })]));
    expect((await screen.findByRole("alert")).textContent).toBe("You can add up to 9 images");
    const [first] = screen.getAllByRole("button", { name: "Remove image" });
    await user.click(first);
    // jsdom has no AnimationEvent, so React listens under the prefixed name.
    const exited = new Event("webkitAnimationEnd", { bubbles: true });
    Object.defineProperty(exited, "animationName", { value: "attach-out" });
    act(() => {
      first.closest(".attachment")!.dispatchEvent(exited);
    });
    expect(screen.getAllByRole("button", { name: "Remove image" })).toHaveLength(8);
    expect(screen.queryByRole("alert")).toBeNull();
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
});
