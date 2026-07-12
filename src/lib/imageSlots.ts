/**
 * Synchronous reservation ledger for attachment work. React state updates can
 * be batched, so using rendered image counts alone lets two paste/drop events
 * claim the same remaining slots before either render commits.
 */
export class ImageSlotLedger {
  private committed: number;
  private reserved = 0;

  constructor(private readonly limit: number, committed = 0) {
    this.committed = committed;
  }

  syncCommitted(count: number): void {
    this.committed = Math.max(0, count);
  }

  reserve(requested: number): number {
    const granted = Math.max(0, Math.min(requested, this.limit - this.committed - this.reserved));
    this.reserved += granted;
    return granted;
  }

  /** Returns false when a concurrent committed attachment consumed the slot. */
  settle(success: boolean): boolean {
    if (this.reserved <= 0) throw new Error("No reserved image slot to settle");
    this.reserved -= 1;
    if (!success || this.committed >= this.limit) return false;
    this.committed += 1;
    return true;
  }

  releaseCommitted(): void {
    this.committed = Math.max(0, this.committed - 1);
  }

  available(): number {
    return Math.max(0, this.limit - this.committed - this.reserved);
  }
}
