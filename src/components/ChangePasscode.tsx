import { KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useModalA11y } from "../hooks/useModalA11y";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { AuthRequiredError, changePassword, verifyPasscode } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { PasscodePad } from "./PasscodePad";

interface ChangePasscodeProps {
  onClose: () => void;
  onDone: () => void;
  onAuthLost: () => void;
}

type Step = "current" | "next" | "confirm";

const STEP_ORDER: Record<Step, number> = { current: 0, next: 1, confirm: 2 };

/**
 * Full-screen overlay reusing the login pad: current → new → confirm. The
 * current passcode is checked as soon as it is entered, so a typo is caught
 * before the new one has been typed twice.
 */
export function ChangePasscode({ onClose, onDone, onAuthLost }: ChangePasscodeProps) {
  const { errorMessage, tr } = useI18n();
  const reducedMotion = useReducedMotion();
  const [step, setStep] = useState<Step>("current");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [entryKey, setEntryKey] = useState(0);
  const [currentPin, setCurrentPin] = useState("");
  const [nextPin, setNextPin] = useState("");
  const [closing, setClosing] = useState(false);
  const padRef = useRef<HTMLElement>(null);
  const closingRef = useRef(false);
  const closeTimer = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  /** Fades the overlay and drops the pad out, then hands over. */
  function leave(callback: () => void) {
    if (closingRef.current) return;
    closingRef.current = true;
    if (reducedMotion) {
      callback();
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(callback, 170);
  }

  function requestClose() {
    if (busy) return;
    leave(() => closeRef.current());
  }

  function advance(next: Step) {
    setStep(next);
    setEntryKey((value) => value + 1);
  }

  function fail(text: string, backTo: Step) {
    setError(true);
    setMessage(text);
    advance(backTo);
  }

  async function handleComplete(pin: string) {
    if (step === "current") {
      setBusy(true);
      try {
        await verifyPasscode(pin);
      } catch (cause) {
        if (cause instanceof AuthRequiredError) {
          onAuthLost();
          return;
        }
        fail(errorMessage(cause, "Couldn’t check the passcode. Try again.", "无法验证密码，请重试"), "current");
        return;
      } finally {
        setBusy(false);
      }
      setCurrentPin(pin);
      advance("next");
      return;
    }
    if (step === "next") {
      if (pin === currentPin) {
        fail(tr("That’s the current passcode. Choose a different one.", "这是当前密码，请换一个新密码"), "next");
        return;
      }
      setNextPin(pin);
      advance("confirm");
      return;
    }
    if (pin !== nextPin) {
      setNextPin("");
      fail(tr("The passcodes didn’t match. Start again.", "两次输入不一致，请重新设置"), "next");
      return;
    }
    setBusy(true);
    // The pad keeps its busy look through the exit rather than flashing
    // back to an editable keypad for the overlay's last frames.
    let exitsBusy = false;
    try {
      await changePassword(currentPin, pin);
      exitsBusy = true;
      leave(() => doneRef.current());
    } catch (cause) {
      if (cause instanceof AuthRequiredError) {
        onAuthLost();
        return;
      }
      setCurrentPin("");
      setNextPin("");
      fail(errorMessage(cause, "Couldn’t change the passcode. Try again.", "修改失败，请重试"), "current");
    } finally {
      if (!exitsBusy) setBusy(false);
    }
  }

  const titles: Record<Step, string> = {
    current: tr("Enter current passcode", "输入当前密码"),
    next: tr("Create a new passcode", "设置新密码"),
    confirm: tr("Enter it again to confirm", "再次输入确认")
  };
  const subtitles: Record<Step, string> = {
    current: tr("Verify your identity before changing the passcode", "验证身份后才能修改密码"),
    next: tr("Enter a new passcode of 4 to 18 digits", "输入新的 4-18 位数字密码"),
    confirm: tr("Enter the new passcode one more time", "请再输入一次新密码")
  };
  // Initial focus goes to the pad itself rather than its first focusable
  // control, the passcode field, which would raise the touch keyboard.
  const overlayRef = useModalA11y<HTMLDivElement>({ onEscape: requestClose, escapeDisabled: busy, initialFocusRef: padRef });

  return (
    <div
      ref={overlayRef}
      className={`passcode-overlay${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={tr("Change passcode", "修改密码")}
      aria-busy={busy || undefined}
      tabIndex={-1}
    >
      <PasscodePad
        rootRef={padRef}
        icon={<KeyRound size={26} aria-hidden="true" />}
        title={titles[step]}
        subtitle={message ?? subtitles[step]}
        error={error}
        busy={busy}
        entryKey={entryKey}
        step={STEP_ORDER[step]}
        autoComplete={step === "current" ? "current-password" : "new-password"}
        onInput={() => {
          setError(false);
          setMessage(null);
        }}
        onComplete={handleComplete}
      />
      <button type="button" className="ghost-button" onClick={requestClose} disabled={busy || closing}>
        {tr("Cancel", "取消")}
      </button>
    </div>
  );
}
