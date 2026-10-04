import { NotebookPen } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../lib/i18n";
import { PasscodePad } from "./PasscodePad";

interface LoginScreenProps {
  needsSetup: boolean;
  /** False on a public host, where the first passcode comes from the deployment. */
  setupAllowed?: boolean;
  onLogin: (pin: string) => Promise<void>;
  onSetup: (pin: string) => Promise<void>;
}

type SetupStep = "enter" | "confirm";

/**
 * Passcode gate. Login mode asks once; first-run setup asks twice (enter +
 * confirm). Nothing behind the gate is fetched until a session cookie exists.
 */
export function LoginScreen({ needsSetup, setupAllowed = true, onLogin, onSetup }: LoginScreenProps) {
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
  // While the passcode is checked and the first page loads, say so.
  const busyLine = busy ? (needsSetup ? tr("Saving your passcode…", "正在保存密码…") : tr("Unlocking…", "正在解锁…")) : null;
  const subtitle =
    busyLine ??
    subtitleOverride ??
    (needsSetup
      ? step === "enter"
        ? tr("First time here? Create a passcode of 4 to 18 digits.", "首次使用，请设置 4-18 位数字密码")
        : tr("Enter the passcode one more time.", "请再输入一次刚才的密码")
      : tr("Enter your passcode to unlock your memos.", "输入密码解锁你的笔记"));

  if (needsSetup && !setupAllowed) {
    // No keypad: setup on a public host can only fail, so say where the
    // passcode comes from instead.
    return (
      <div className="login-screen">
        <section className="pin-pad setup-blocked" aria-labelledby="setup-blocked-title">
          <div className="pin-brand">
            <div className="pin-logo">
              <NotebookPen size={26} aria-hidden="true" />
            </div>
            <h1 id="setup-blocked-title">{tr("Set the passcode at deploy time", "在部署时设置密码")}</h1>
            <p>
              {tr(
                "This MEMO is on a public address, so its first passcode can’t be created here.",
                "这个 MEMO 部署在公网地址上，不能在这里创建首个密码。"
              )}
            </p>
          </div>
          <ol className="setup-steps">
            <li>
              {tr("Hash a passcode:", "生成密码哈希：")} <code>
                npm run hash-password -- <span>"&lt;digits&gt;"</span>
              </code>
            </li>
            <li>
              {tr("Store the output:", "保存输出结果：")} <code>npx wrangler pages secret put APP_PASSWORD_HASH</code>
            </li>
            <li>{tr("Redeploy, then reload this page.", "重新部署，然后刷新本页。")}</li>
          </ol>
        </section>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <PasscodePad
        autoComplete={needsSetup ? "new-password" : "current-password"}
        icon={<NotebookPen size={26} aria-hidden="true" />}
        title={title}
        subtitle={subtitle}
        error={error}
        busy={busy}
        entryKey={entryKey}
        step={needsSetup && step === "confirm" ? 1 : 0}
        onInput={() => {
          setError(false);
          setSubtitleOverride(null);
        }}
        onComplete={handleComplete}
      />
    </div>
  );
}
