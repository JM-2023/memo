import { CloudOff, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "../lib/i18n";
import { RollingText } from "./RollingText";

interface FeedEndProps {
  /** Memos in hand so far, capped at the cold start's frozen total. */
  loaded: number;
  /** Memos at the frozen cursor; null if the first page didn't say. */
  total: number | null;
  /** Pages keep failing; the sync notice above offers the Retry. */
  failed: boolean;
}

/**
 * The foot of a list that has run out while a cold start is still loading
 * older pages behind it: the reader who scrolls this far learns the list
 * goes on, rather than taking its last card for the notebook's oldest. One
 * quiet line in the sync notice's voice, with no surface of its own. The
 * spinner waits out the busy hold, so a page that lands at once never
 * flashes it. A load that keeps failing says so here in the notice's words;
 * the Retry stays the notice's own (one button, not two on a short list),
 * and the load keeps trying by itself meanwhile.
 *
 * Not a live region: the count ticks per page, and a stalled load is
 * already spoken (App announces it).
 */
export function FeedEnd({ loaded, total, failed }: FeedEndProps) {
  const { formatNumber, tr } = useI18n();

  let text: string;
  // The same words with the count on the odometer, as the sync notice's.
  let line: ReactNode = null;
  if (failed) {
    text =
      total === null
        ? tr(`Couldn’t load the rest of your memos · ${formatNumber(loaded)} loaded`, `其余笔记载入失败 · 已载入 ${formatNumber(loaded)} 条`)
        : tr(
            `Couldn’t load the rest of your memos · ${formatNumber(loaded)} of ${formatNumber(total)} loaded`,
            `其余笔记载入失败 · 已载入 ${formatNumber(loaded)} / ${formatNumber(total)}`
          );
  } else if (total === null) {
    text = tr(`Loading older memos · ${formatNumber(loaded)} loaded`, `正在载入更早的笔记 · 已载入 ${formatNumber(loaded)} 条`);
    line = (
      <>
        {tr("Loading older memos · ", "正在载入更早的笔记 · 已载入 ")}
        <RollingText value={loaded} />
        {tr(" loaded", " 条")}
      </>
    );
  } else {
    text = tr(`Loading older memos · ${formatNumber(loaded)} of ${formatNumber(total)}`, `正在载入更早的笔记 · ${formatNumber(loaded)} / ${formatNumber(total)}`);
    line = (
      <>
        {tr("Loading older memos · ", "正在载入更早的笔记 · ")}
        <RollingText value={loaded} />
        {tr(` of ${formatNumber(total)}`, ` / ${formatNumber(total)}`)}
      </>
    );
  }

  return (
    <div className="feed-end-slot">
      <div className="feed-end-clip">
        <div className={`feed-end${failed ? " is-failed" : ""}`}>
          {failed ? (
            <CloudOff size={14} aria-hidden="true" />
          ) : (
            <span className="feed-end-spinner" aria-hidden="true">
              <Loader2 size={14} className="spin" />
            </span>
          )}
          {line ? (
            <span className="feed-end-text">
              <span className="sr-only">{text}</span>
              <span aria-hidden="true">{line}</span>
            </span>
          ) : (
            <span className="feed-end-text">{text}</span>
          )}
        </div>
      </div>
    </div>
  );
}
