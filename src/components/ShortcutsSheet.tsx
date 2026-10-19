import { X } from "lucide-react";
import { Fragment, useId, useRef } from "react";
import { useBackdropDismiss } from "../hooks/useBackdropDismiss";
import { useModalA11y } from "../hooks/useModalA11y";
import { useCloseSignal, useOverlayExit } from "../hooks/useOverlayExit";
import { useI18n } from "../lib/i18n";
import { isApplePlatform } from "../lib/shortcuts";

interface ShortcutsSheetProps {
  onClose: () => void;
  /** Bumped by Back: leave as the ✕ would. */
  closeSignal?: number;
}

interface Shortcut {
  /** Each entry is one way to press it; the keys within are held together. */
  keys: string[][];
  label: string;
}

/**
 * The keyboard's map of the app, opened with ?. The confirm card's surface
 * (a bottom sheet on a phone), Esc or the scrim to leave. ⌘↩ is listed here
 * only — the Send button itself carries no hint.
 */
export function ShortcutsSheet({ onClose, closeSignal }: ShortcutsSheetProps) {
  const { tr } = useI18n();
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const overlayRef = useModalA11y<HTMLDivElement>({ onEscape: requestClose });
  const { closing, closingRef, leave } = useOverlayExit(overlayRef);
  const backdrop = useBackdropDismiss(requestClose);
  useCloseSignal(closeSignal, requestClose);

  function requestClose() {
    if (closingRef.current) return;
    leave(() => closeRef.current());
  }

  const mod = isApplePlatform() ? "⌘" : "Ctrl";
  const general: Shortcut[] = [
    { keys: [["/"], [mod, "K"]], label: tr("Search", "搜索") },
    { keys: [["N"]], label: tr("New memo", "新建") },
    { keys: [[mod, "↩"]], label: tr("Send or save", "发送/保存") },
    { keys: [["Esc"]], label: tr("Close, clear or cancel", "关闭、清空或取消") },
    { keys: [[mod, "Z"]], label: tr("Undo", "撤销") },
    { keys: [["?"]], label: tr("This list", "显示本列表") }
  ];
  const editor: Shortcut[] = [
    { keys: [[mod, "B"]], label: tr("Bold", "粗体") },
    { keys: [[mod, "I"]], label: tr("Italic", "斜体") },
    { keys: [[mod, "E"]], label: tr("Code", "代码") },
    { keys: [[mod, "⇧", "S"]], label: tr("Strikethrough", "删除线") },
    { keys: [[mod, "⇧", "H"]], label: tr("Highlight", "高亮") },
    { keys: [[mod, "K"]], label: tr("Link", "链接") }
  ];

  const list = (items: Shortcut[]) => (
    <dl className="shortcut-list">
      {items.map((item) => (
        <div key={item.label} className="shortcut-row">
          <dt>{item.label}</dt>
          <dd>
            {item.keys.map((combo, index) => (
              <Fragment key={combo.join("+")}>
                {index > 0 ? <span className="shortcut-or">{tr("or", "或")}</span> : null}
                <span className="shortcut-combo">
                  {combo.map((key) => (
                    <kbd key={key} className="keycap">
                      {key}
                    </kbd>
                  ))}
                </span>
              </Fragment>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );

  return (
    <div
      ref={overlayRef}
      className={`overlay${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      {...backdrop}
    >
      <div className="confirm-card shortcuts-card" onClick={(event) => event.stopPropagation()}>
        {/* The title is the card's own child, so on a phone the sheet is
            pulled down from it like every other (useBackdropDismiss). */}
        <h2 id={titleId}>{tr("Keyboard shortcuts", "键盘快捷键")}</h2>
        <button type="button" className="icon-button shortcuts-close" aria-label={tr("Close", "关闭")} onClick={requestClose}>
          <X size={16} aria-hidden="true" />
        </button>
        {list(general)}
        <h3 className="shortcuts-subhead">{tr("In the editor", "编辑器中")}</h3>
        {list(editor)}
      </div>
    </div>
  );
}
