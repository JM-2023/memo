import { NotebookPen } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../lib/i18n";
import { PasscodePad } from "./PasscodePad";

interface LoginScreenProps {
  needsSetup: boolean;
  onLogin: (pin: string) => Promise<void>;
  onSetup: (pin: string) => Promise<void>;
}

type SetupStep = "enter" | "confirm";

/**
 * Passcode gate. Login mode asks once; first-run setup asks twice (enter +
 * confirm). Nothing behind the gate is fetched until a session cookie exists.
 */
export function LoginScreen({ needsSetup, onLogin, onSetup }: LoginScreenProps) {
  const { errorMessage, tr } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [subtitleOverride, setSubtitleOverride] = useState<string | null>(null);
  const [entryKey, setEntryKey] = useState(0);
  const [step, setStep] = useState<SetupStep>("enter");
  const [firstPin, setFirstPin] = useState("");

  function fail(message: string) {
    setError(true);
    setSubtitleOverride(message);
    setEntryKey((value) => value + 1);
  }

  async function handleComplete(pin: string) {
    if (!needsSetup) {
      setBusy(true);
      try {
        await onLogin(pin);
      } catch (cause) {
        fail(errorMessage(cause, "Couldn’t sign in. Try again.", "登录失败，请重试"));
      } finally {
        setBusy(false);
      }
      return;
    }

    if (step === "enter") {
      setFirstPin(pin);
      setStep("confirm");
      setEntryKey((value) => value + 1);
      return;
    }
    if (pin !== firstPin) {
      setStep("enter");
      setFirstPin("");
      fail(tr("The passcodes didn’t match. Start again.", "两次输入不一致，请重新设置"));
      return;
    }
    setBusy(true);
    try {
      await onSetup(pin);
    } catch (cause) {
      setStep("enter");
      setFirstPin("");
      fail(errorMessage(cause, "Couldn’t set the passcode. Try again.", "设置失败，请重试"));
    } finally {
      setBusy(false);
    }
  }

  const title = needsSetup ? (step === "enter" ? tr("Create an access passcode", "创建访问密码") : tr("Enter it again to confirm", "再次输入确认")) : "MEMO";
  const subtitle =
    subtitleOverride ??
    (needsSetup
      ? step === "enter"
        ? tr("First time here? Create a 4-digit passcode.", "首次使用，请设置 4 位数字密码")
        : tr("Enter the passcode one more time.", "请再输入一次刚才的密码")
      : tr("Enter your 4-digit passcode to unlock your memos.", "输入 4 位密码解锁你的笔记"));

  return (
    <div className="login-screen">
      <PasscodePad
        icon={<NotebookPen size={26} aria-hidden="true" />}
        title={title}
        subtitle={subtitle}
        error={error}
        busy={busy}
        entryKey={entryKey}
        onInput={() => {
          setError(false);
          setSubtitleOverride(null);
        }}
        onComplete={handleComplete}
      />
    </div>
  );
}
