import { describe, expect, it } from "vitest";
import { ImageSlotLedger } from "../src/lib/imageSlots";

describe("ImageSlotLedger", () => {
  it("reserves concurrent batches against the same hard limit", () => {
    const slots = new ImageSlotLedger(9, 7);

    expect(slots.reserve(2)).toBe(2);
    expect(slots.reserve(2)).toBe(0);
    expect(slots.available()).toBe(0);
  });

  it("releases failed and removed work without overbooking", () => {
    const slots = new ImageSlotLedger(3, 1);

    expect(slots.reserve(2)).toBe(2);
    expect(slots.settle(true)).toBe(true);
    expect(slots.settle(false)).toBe(false);
    expect(slots.available()).toBe(1);

    slots.releaseCommitted();
    expect(slots.available()).toBe(2);
  });

  it("rejects a reserved result when a remote attachment fills the slot", () => {
    const slots = new ImageSlotLedger(3, 2);
    expect(slots.reserve(1)).toBe(1);

    slots.syncCommitted(3);
    expect(slots.settle(true)).toBe(false);
    expect(slots.available()).toBe(0);
  });
});
