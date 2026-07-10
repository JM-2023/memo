import { KeyRound } from "lucide-react";
import { useState } from "react";
import { changePassword } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { PasscodePad } from "./PasscodePad";

interface ChangePasscodeProps {
  onClose: () => void;
  onDone: () => void;
}

type Step = "current" | "next" | "confirm";

/** Full-screen overlay reusing the login pad: current → new → confirm. */
export function ChangePasscode({ onClose, onDone }: ChangePasscodeProps) {
  const { errorMessage, tr } = useI18n();
  const [step, setStep] = useState<Step>("current");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [entryKey, setEntryKey] = useState(0);
  const [currentPin, setCurrentPin] = useState("");
  const [nextPin, setNextPin] = useState("");

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
      setCurrentPin(pin);
      advance("next");
      return;
    }
    if (step === "next") {
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
    try {
      await changePassword(currentPin, pin);
      onDone();
    } catch (cause) {
      setCurrentPin("");
      setNextPin("");
      fail(errorMessage(cause, "Couldn’t change the passcode. Try again.", "修改失败，请重试"), "current");
    } finally {
      setBusy(false);
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

  return (
    <div className="passcode-overlay" role="dialog" aria-modal="true" aria-label={tr("Change passcode", "修改密码")}>
      <PasscodePad
        icon={<KeyRound size={26} aria-hidden="true" />}
        title={titles[step]}
        subtitle={message ?? subtitles[step]}
        error={error}
        busy={busy}
        entryKey={entryKey}
        onInput={() => {
          setError(false);
          setMessage(null);
        }}
        onComplete={handleComplete}
      />
      <button type="button" className="ghost-button" onClick={onClose}>
        {tr("Cancel", "取消")}
      </button>
    </div>
  );
}
