import { useEffect, useState } from "react";
import type { Outbox } from "../lib/outbox";
import { OutboxQueue } from "../lib/outboxQueue";

/**
 * The send queue (lib/outboxQueue) for a component: one queue for its
 * lifetime, whose every change renders (`outbox`). The queue's callbacks are
 * the component's to hand over with `queue.connect`, on every render, once
 * everything they reach is defined. The queue sends again as the browser
 * comes online or the page back into view, and no clock of its outlives the
 * component.
 */
export function useOutbox(keepDiscarded?: number): { outbox: Outbox; queue: OutboxQueue } {
  const [outbox, setOutbox] = useState<Outbox>(() => new Map());
  const [queue] = useState(() => new OutboxQueue(null, { onChange: setOutbox, keepDiscarded }));
  useEffect(() => () => queue.dispose(), [queue]);
  useEffect(() => queue.listen(), [queue]);
  return { outbox, queue };
}
