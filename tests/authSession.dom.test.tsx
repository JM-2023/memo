// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { ChangePasscode } from "../src/components/ChangePasscode";
import { LoginScreen } from "../src/components/LoginScreen";
import { PasscodePad } from "../src/components/PasscodePad";
import { TipProvider } from "../src/components/Tip";
import { ApiError } from "../src/lib/api";
import { defaultLanguage, LanguageProvider } from "../src/lib/i18n";
import type { Memo } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  bootstrap: vi.fn(),
  syncSince: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  verifyPasscode: vi.fn(),
  changePassword: vi.fn(),
  updateMemo: vi.fn(),
  clearLocalDeviceData: vi.fn(async () => undefined),
  forgetCacheKey: vi.fn(),
  syncOptions: null as null | { onAuthLost: (revoked: boolean) => void },
  syncApi: {
    setCursor: vi.fn(),
    setSyncEpoch: vi.fn(),
    runSync: vi.fn(async () => undefined),
    notifyPeers: vi.fn(),
    notifyLogout: vi.fn(),
    status: { online: true, degraded: false },
    retryNow: vi.fn()
  }
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    getAuthStatus: mocks.getAuthStatus,
    bootstrap: mocks.bootstrap,
    syncSince: mocks.syncSince,
    login: mocks.login,
    logout: mocks.logout,
    verifyPasscode: mocks.verifyPasscode,
    changePassword: mocks.changePassword,
    updateMemo: mocks.updateMemo
  };
});

vi.mock("../src/lib/cache", () => ({
  adoptCacheKey: vi.fn(),
  forgetCacheKey: mocks.forgetCacheKey,
  invalidateSnapshot: vi.fn(async () => undefined),
  openSnapshot: vi.fn(async () => null),
  readSealedSnapshot: vi.fn(async () => null),
  saveSnapshot: vi.fn(async () => undefined)
}));

vi.mock("../src/lib/logoutCleanup", () => ({ clearLocalDeviceData: mocks.clearLocalDeviceData }));

vi.mock("../src/lib/useSync", () => ({
  useSync: (options: { onAuthLost: (revoked: boolean) => void }) => {
    mocks.syncOptions = options;
    return mocks.syncApi;
  }
}));

function Providers({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <TipProvider>{children}</TipProvider>
    </LanguageProvider>
  );
}

function memo(index: number): Memo {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    id: `memo-${index}`,
    content: `memo-${index} original`,
    createdAt: timestamp,
    updatedAt: timestamp,
    pinnedAt: null,
    deletedAt: null,
    seq: index + 1,
    images: []
  };
}

function stubMatchMedia(finePointer = false) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion") || (finePointer && query.includes("pointer: fine")),
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
  mocks.getAuthStatus.mockResolvedValue({ needsSetup: false, setupAllowed: true });
  mocks.bootstrap.mockResolvedValue({
    memos: [memo(0), memo(1)],
    tags: [],
    cursor: 2,
    syncEpoch: "epoch-a",
    serverTime: "2026-01-01T00:02:00.000Z",
    hasMore: false,
    nextAfter: null
  });
  mocks.syncSince.mockResolvedValue({ memos: [], purged: [], tags: [], cursor: 2, syncEpoch: "epoch-a", serverTime: "2026-01-01T00:02:00.000Z" });
  mocks.login.mockResolvedValue({ ok: true });
  mocks.logout.mockResolvedValue({ ok: true });
  stubMatchMedia();
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: vi.fn(() => []) });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 20, 20)] as unknown as DOMRectList);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
    }
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
});

afterEach(() => {
  cleanup();
  delete (Element.prototype as Element & { getAnimations?: () => Animation[] }).getAnimations;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function renderReadyApp() {
  render(
    <Providers>
      <App />
    </Providers>
  );
  await screen.findByText("memo-1 original");
}

function composer(): HTMLTextAreaElement {
  const field = document.querySelector<HTMLTextAreaElement>(".composer textarea");
  if (!field) throw new Error("Composer is not rendered");
  return field;
}

async function signInAgain(user: ReturnType<typeof userEvent.setup>, confirmLabel = "Confirm") {
  await screen.findByRole("button", { name: confirmLabel });
  await user.keyboard("2468{Enter}");
  await screen.findByText("memo-0 original");
}

describe("losing the session mid-use", () => {
  it("treats plain expiry like a cold start and gives the unsent drafts back after sign-in", async () => {
    const user = userEvent.setup();
    await renderReadyApp();

    await user.type(composer(), "unsent thought");
    const card = screen.getByText("memo-1 original").closest("article")!;
    await user.click(within(card).getByRole("button", { name: /^Memo actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    const edit = await within(card).findByRole("combobox");
    await user.clear(edit);
    await user.type(edit, "half-finished edit");

    act(() => mocks.syncOptions!.onAuthLost(false));

    expect(await screen.findByText("Your session has expired. Enter your passcode again.", { selector: ".toast *" })).not.toBeNull();
    expect(mocks.forgetCacheKey).toHaveBeenCalled();
    expect(mocks.clearLocalDeviceData).not.toHaveBeenCalled();

    await signInAgain(user);
    expect(mocks.login).toHaveBeenCalledWith("2468");
    expect(composer().value).toBe("unsent thought");
    const resumed = document.querySelector<HTMLTextAreaElement>(".editor-edit textarea");
    expect(resumed?.value).toBe("half-finished edit");
  });

  it("resumes an edit on its original base, so a change made elsewhere meanwhile still raises the conflict", async () => {
    const user = userEvent.setup();
    await renderReadyApp();

    const card = screen.getByText("memo-1 original").closest("article")!;
    await user.click(within(card).getByRole("button", { name: /^Memo actions/ }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    const edit = await within(card).findByRole("combobox");
    await user.clear(edit);
    await user.type(edit, "half-finished edit");

    act(() => mocks.syncOptions!.onAuthLost(false));
    await screen.findByText("Your session has expired. Enter your passcode again.", { selector: ".toast *" });

    // Another device saved memo-1 while this one sat at the gate.
    mocks.bootstrap.mockResolvedValueOnce({
      memos: [memo(0), { ...memo(1), content: "memo-1 changed elsewhere", seq: 9 }],
      tags: [],
      cursor: 9,
      syncEpoch: "epoch-a",
      serverTime: "2026-01-01T00:09:00.000Z",
      hasMore: false,
      nextAfter: null
    });
    await signInAgain(user);

    expect(await screen.findByText(/This memo changed elsewhere\. Your draft is preserved/)).not.toBeNull();
    const resumed = document.querySelector<HTMLTextAreaElement>(".editor-edit textarea")!;
    expect(resumed.value).toBe("half-finished edit");

    // Nothing goes out over the other device's change until the owner says so.
    const editor = resumed.closest(".editor-edit") as HTMLElement;
    const save = within(editor).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.click(save);
    expect(mocks.updateMemo).not.toHaveBeenCalled();

    // Keeping the draft rebases it on the newer version, on purpose.
    mocks.updateMemo.mockResolvedValueOnce({ memo: { ...memo(1), content: "half-finished edit", seq: 10 } });
    await user.click(within(editor).getByRole("button", { name: "Keep my draft and continue" }));
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.updateMemo).toHaveBeenCalledTimes(1));
    expect(mocks.updateMemo.mock.calls[0][0]).toBe("memo-1");
    expect(mocks.updateMemo.mock.calls[0][1]).toMatchObject({ content: "half-finished edit", expectedSeq: 9 });
  });

  it("clears the device only when the session was revoked, and keeps the language", async () => {
    const user = userEvent.setup();
    localStorage.setItem("memo:language", "zh-CN");
    await renderReadyApp();
    await user.type(composer(), "草稿");

    act(() => mocks.syncOptions!.onAuthLost(true));

    expect(await screen.findByText("密码已更改，请输入新密码继续", { selector: ".toast *" })).not.toBeNull();
    expect(mocks.clearLocalDeviceData).toHaveBeenCalledTimes(1);
    expect(document.documentElement.lang).toBe("zh-CN");

    await signInAgain(user, "确认");
    expect(composer().value).toBe("草稿");
  });
});

describe("logging out", () => {
  it("asks first and names what the device forgets", async () => {
    const user = userEvent.setup();
    await renderReadyApp();

    await user.click(screen.getByRole("button", { name: /My MEMO/ }));
    await user.click(screen.getByRole("menuitem", { name: "Log Out" }));
    const dialog = await screen.findByRole("dialog", { name: "Log out of this device?" });
    expect(dialog.textContent).toContain("saved filters");
    expect(dialog.textContent).toContain("semantic search model stay");
    expect(mocks.logout).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Log Out" }));
    await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1));
    expect(mocks.clearLocalDeviceData).toHaveBeenCalledTimes(1);
    await screen.findByRole("button", { name: "Confirm" });
  });
});

describe("passcode entry", () => {
  it("takes pasted digits and password-manager autofill", () => {
    const onComplete = vi.fn();
    render(
      <LanguageProvider>
        <PasscodePad icon={null} title="Unlock" subtitle="Enter passcode" onComplete={onComplete} />
      </LanguageProvider>
    );
    const field = screen.getByLabelText("Passcode") as HTMLInputElement;
    expect(field.getAttribute("autocomplete")).toBe("current-password");
    expect(field.getAttribute("inputmode")).toBe("numeric");

    const paste = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: { getData: () => string } };
    paste.clipboardData = { getData: () => " 12-34 56 " };
    act(() => {
      screen.getByRole("button", { name: "1" }).dispatchEvent(paste);
    });
    expect(paste.defaultPrevented).toBe(true);
    expect(field.value).toBe("123456");

    fireEvent.change(field, { target: { value: "908172" } });
    expect(field.value).toBe("908172");
    fireEvent.submit(field.form!);
    expect(onComplete).toHaveBeenCalledWith("908172");
  });

  it("does not double digits typed into the focused field", async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(
      <LanguageProvider>
        <PasscodePad icon={null} title="Unlock" subtitle="Enter passcode" onComplete={onComplete} />
      </LanguageProvider>
    );
    const field = screen.getByLabelText("Passcode") as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(field));
    await user.keyboard("54321{Backspace}{Enter}");
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("5432");
  });

  it("explains the deploy step instead of offering a keypad on a public host", () => {
    render(
      <LanguageProvider>
        <LoginScreen needsSetup setupAllowed={false} onLogin={vi.fn()} onSetup={vi.fn()} />
      </LanguageProvider>
    );
    expect(screen.getByRole("heading", { name: "Set the passcode at deploy time" })).not.toBeNull();
    expect(screen.getByText(/APP_PASSWORD_HASH/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });
});

describe("changing the passcode", () => {
  it("rejects a wrong current passcode before asking for a new one", async () => {
    const user = userEvent.setup();
    mocks.verifyPasscode.mockRejectedValueOnce(new ApiError("WRONG_CURRENT_PASSCODE", 401, "Wrong current passcode"));
    mocks.verifyPasscode.mockResolvedValueOnce({ ok: true });
    render(
      <LanguageProvider>
        <ChangePasscode onClose={vi.fn()} onDone={vi.fn()} onAuthLost={vi.fn()} />
      </LanguageProvider>
    );

    await user.keyboard("1111{Enter}");
    expect(await screen.findByText("The current passcode is incorrect. Please try again.")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Enter current passcode" })).not.toBeNull();

    await user.keyboard("2468{Enter}");
    expect(await screen.findByRole("heading", { name: "Create a new passcode" })).not.toBeNull();
    await user.keyboard("2468{Enter}");
    expect(await screen.findByText("That’s the current passcode. Choose a different one.")).not.toBeNull();
    expect(mocks.changePassword).not.toHaveBeenCalled();
  });
});

describe("default language", () => {
  it("follows the browser's first preferred language when nothing is stored", () => {
    const languages = vi.spyOn(navigator, "languages", "get");
    languages.mockReturnValue(["zh-TW", "en"]);
    expect(defaultLanguage()).toBe("zh-CN");
    languages.mockReturnValue(["en-GB", "zh-CN"]);
    expect(defaultLanguage()).toBe("en");
  });
});
