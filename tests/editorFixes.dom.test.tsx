// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor, type EditDraft } from "../src/components/Editor";
import { TipProvider } from "../src/components/Tip";
import { LanguageProvider } from "../src/lib/i18n";
import type { NewImagePayload } from "../src/lib/types";

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

/** A minimal stand-in for the browser's undoable insertText command. */
function installExecCommand() {
  const calls: Array<[string, string | undefined]> = [];
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: vi.fn((command: string, _ui: boolean, text?: string) => {
      calls.push([command, text]);
      const area = document.activeElement;
      if (!(area instanceof HTMLTextAreaElement)) return false;
      area.setRangeText(command === "insertText" ? text ?? "" : "", area.selectionStart, area.selectionEnd, "end");
      area.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: command === "insertText" ? "insertText" : "deleteContentBackward" }));
      return true;
    })
  });
  return calls;
}

function clipboard(data: Record<string, string>) {
  return { clipboardData: { items: [], types: Object.keys(data), getData: (type: string) => data[type] ?? "" } };
}

function dataTransfer(data: Record<string, string>) {
  return { dataTransfer: { files: [], types: Object.keys(data), getData: (type: string) => data[type] ?? "" } };
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
});

afterEach(() => {
  cleanup();
  delete (document as Document & { execCommand?: unknown }).execCommand;
  vi.unstubAllGlobals();
});

describe("Editor native undo", () => {
  it("lands list continuation and ⌘B through insertText, replacing only the changed span", async () => {
    const calls = installExecCommand();
    const user = userEvent.setup();
    render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={vi.fn(async () => true)} />
      </Providers>
    );
    const area = field();
    await user.type(area, "- milk");
    calls.length = 0;
    fireEvent.keyDown(area, { key: "Enter" });
    expect(calls).toEqual([["insertText", "\n- "]]);
    expect(area.value).toBe("- milk\n- ");
    expect(area.selectionStart).toBe(9);

    area.setSelectionRange(2, 6);
    fireEvent.keyDown(area, { key: "b", metaKey: true });
    expect(calls[1][0]).toBe("insertText");
    expect(area.value).toBe("- **milk**\n- ");
    expect(area.value.slice(area.selectionStart, area.selectionEnd)).toBe("milk");
  });

  it("falls back to a direct write when execCommand is unavailable", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={vi.fn(async () => true)} />
      </Providers>
    );
    const area = field();
    await user.type(area, "- milk{Enter}eggs");
    expect(area.value).toBe("- milk\n- eggs");
  });
});

describe("Editor toolbar", () => {
  it("never takes focus from the field, so iOS keeps its keyboard up", async () => {
    render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={vi.fn(async () => true)} />
      </Providers>
    );
    for (const name of ["Insert tag", "Bold", "Bullet list", "Insert table", "Add image", "Insert image link"]) {
      expect(fireEvent.mouseDown(screen.getByRole("button", { name }))).toBe(false);
    }
  });

  it("toggles every selected line and steps a bullet on to a task", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={vi.fn(async () => true)} />
      </Providers>
    );
    const area = field();
    await user.type(area, "milk{Shift>}{Enter}{/Shift}eggs");
    area.setSelectionRange(0, area.value.length);
    await user.click(screen.getByRole("button", { name: "Bullet list" }));
    expect(area.value).toBe("- milk\n- eggs");
    area.setSelectionRange(0, area.value.length);
    await user.click(screen.getByRole("button", { name: "Bullet list" }));
    expect(area.value).toBe("- [ ] milk\n- [ ] eggs");
  });

  it("gives the image-link field a URL keyboard without autocorrect", () => {
    render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={vi.fn(async () => true)} />
      </Providers>
    );
    const input = document.querySelector(".link-pop-inner input") as HTMLInputElement;
    expect(input.type).toBe("url");
    expect(input.getAttribute("inputmode")).toBe("url");
    expect(input.getAttribute("autocapitalize")).toBe("off");
    expect(input.getAttribute("autocorrect")).toBe("off");
  });
});

describe("Editor paste and drop", () => {
  function renderCreate() {
    render(
      <Providers>
        <Editor mode="create" knownTags={[]} busy={false} onSubmit={vi.fn(async () => true)} />
      </Providers>
    );
    return field();
  }

  it("links the selected words when a lone URL is pasted over them", async () => {
    const user = userEvent.setup();
    const area = renderCreate();
    await user.type(area, "see the docs now");
    area.setSelectionRange(3, 13);
    const notPrevented = fireEvent.paste(area, clipboard({ "text/plain": "https://example.com/docs" }));
    expect(notPrevented).toBe(false);
    await vi.waitFor(() => expect(area.value).toBe("see [the docs](https://example.com/docs) now"));
  });

  it("pastes rich HTML as Markdown, but leaves plain text and ⌘⇧V to the browser", async () => {
    const user = userEvent.setup();
    const area = renderCreate();
    await user.click(area);
    const rich = clipboard({ "text/plain": "Title\nbold", "text/html": "<h2>Title</h2><p><strong>bold</strong></p>" });
    expect(fireEvent.paste(area, rich)).toBe(false);
    await vi.waitFor(() => expect(area.value).toBe("## Title\n**bold**"));

    expect(fireEvent.paste(area, clipboard({ "text/plain": "just text" }))).toBe(true);
    fireEvent.keyDown(area, { key: "v", metaKey: true, shiftKey: true });
    expect(fireEvent.paste(area, rich)).toBe(true);
  });

  it("drops a page link as a link and an image as an external image", async () => {
    const area = renderCreate();
    const editor = area.closest(".editor")!;
    fireEvent.drop(editor, dataTransfer({ "text/uri-list": "https://example.com/article" }));
    await vi.waitFor(() => expect(area.value).toBe("https://example.com/article "));

    fireEvent.drop(editor, dataTransfer({ "text/uri-list": "https://cdn.example.com/p/123", "text/html": '<img src="https://cdn.example.com/p/123">' }));
    await vi.waitFor(() => expect(area.value).toContain("![](https://cdn.example.com/p/123)"));

    fireEvent.drop(
      editor,
      dataTransfer({ "text/uri-list": "https://example.com/post", "text/html": '<a href="https://example.com/post"><img src="https://cdn.example.com/thumb"></a>' })
    );
    await vi.waitFor(() => expect(area.value).toMatch(/ https:\/\/example\.com\/post $/));
  });

  it("leaves a link drag over the field to the browser, so it drops at the drop caret", () => {
    const area = renderCreate();
    const editor = area.closest(".editor")!;
    // No veil: it would cover the native drop caret.
    expect(fireEvent.dragEnter(area, dataTransfer({ "text/uri-list": "https://example.com" }))).toBe(true);
    expect(editor.classList.contains("is-dropping")).toBe(false);
    // Over the field the browser keeps the drop (and its caret); beside it,
    // the editor accepts the link for the field's own caret.
    expect(fireEvent.dragOver(area, dataTransfer({ "text/uri-list": "https://example.com" }))).toBe(true);
    expect(fireEvent.dragOver(editor.querySelector(".editor-bar")!, dataTransfer({ "text/uri-list": "https://example.com" }))).toBe(false);
    // A plain-text drop (or a selection moved within the field) is not cancelled.
    expect(fireEvent.drop(area, dataTransfer({ "text/plain": "moved words" }))).toBe(true);
    expect(fireEvent.drop(area, dataTransfer({ "text/uri-list": "https://example.com/page", "text/plain": "https://example.com/page" }))).toBe(true);
    expect(area.value).toBe("");
  });
});

describe("Editor cancel", () => {
  function renderEdit(onCancel: (draft: EditDraft | null) => void, initialDraft: EditDraft | null = null) {
    render(
      <Providers>
        <Editor
          mode="edit"
          initialContent="original"
          knownTags={[]}
          busy={false}
          onSubmit={vi.fn(async () => true)}
          onCancel={onCancel}
          initialDraft={initialDraft}
          autoFocus
        />
      </Providers>
    );
    return field();
  }

  it("closes an untouched edit without a draft, Esc or Cancel alike", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    const area = renderEdit(onCancel);
    await user.type(area, "  ");
    fireEvent.keyDown(area, { key: "Escape" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel.mock.calls).toEqual([[null], [null]]);
  });

  it("hands a dirty edit up as a draft, and reopens one as it was", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    const area = renderEdit(onCancel);
    await user.type(area, " plus more");
    area.setSelectionRange(2, 4);
    fireEvent.keyDown(area, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledWith({ content: "original plus more", newImages: [], removedIds: [], selectionStart: 2, selectionEnd: 4 });
    cleanup();

    const image: NewImagePayload = { id: "img", dataBase64: "AA==", mime: "image/webp", width: 1, height: 1, previewUrl: "blob:img" };
    const reopened = renderEdit(vi.fn(), { content: "original plus more", newImages: [image], removedIds: [], selectionStart: 2, selectionEnd: 4 });
    expect(reopened.value).toBe("original plus more");
    expect([reopened.selectionStart, reopened.selectionEnd]).toEqual([2, 4]);
    expect(document.querySelectorAll(".attachment img")).toHaveLength(1);
  });

  it("leaves Esc to the IME while it is composing", () => {
    const onCancel = vi.fn();
    const area = renderEdit(onCancel);
    fireEvent.keyDown(area, { key: "Escape", isComposing: true });
    fireEvent.keyDown(area, { key: "Escape", keyCode: 229 });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
