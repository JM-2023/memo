import { useEffect, useRef, useState, type ReactNode } from "react";

interface FeedFootProps {
  /** The line: what the list holds, said once it has all arrived. */
  children: ReactNode;
}

/**
 * The foot of a list that has fully arrived: one quiet line between two
 * hairlines, so the last card reads as the last one rather than as a page
 * still loading. It rises in (rise-in, --t-enter) the first time it is
 * scrolled into view; a new list keys a fresh one, which rises again.
 *
 * It stands after the feed, not in it: only slots move with the feed's
 * motion layer, and anything else inside the list would jump.
 *
 * App sets the line for the memo lists; a view that owns its own foot
 * (Daily review) renders this with its line.
 */
export function FeedFoot({ children }: FeedFootProps) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const foot = ref.current;
    if (!foot || shown) return;
    if (typeof IntersectionObserver !== "function") {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      setShown(true);
    });
    observer.observe(foot);
    return () => observer.disconnect();
  }, [shown]);
  return (
    <p ref={ref} className={`feed-foot${shown ? " is-shown" : ""}`}>
      <span className="feed-foot-text">{children}</span>
    </p>
  );
}
