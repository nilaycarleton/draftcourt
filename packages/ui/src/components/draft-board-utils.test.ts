import { describe, expect, it } from "vitest";
import { columnForSlot, rowOffset, slotAtCell, visibleRowWindow } from "./draft-board-utils";

describe("visibleRowWindow", () => {
  it("returns the rows covering the viewport plus overscan", () => {
    // rowHeight 44, viewport 440 → 10 visible rows; overscan 3 each side.
    expect(visibleRowWindow(440, 440, 44, 3, 100)).toEqual({ start: 7, end: 23 });
  });

  it("clamps to zero at the top and totalRows at the bottom", () => {
    expect(visibleRowWindow(0, 440, 44, 3, 12)).toEqual({ start: 0, end: 12 });
    const bottom = visibleRowWindow(44 * 99, 440, 44, 3, 100);
    expect(bottom.end).toBe(100);
    expect(bottom.start).toBeGreaterThanOrEqual(0);
  });

  it("renders nothing for a zero-height viewport instead of an inverted window", () => {
    expect(visibleRowWindow(-500, 0, 0.0001, 0, 5)).toEqual({ start: 0, end: 0 });
    expect(visibleRowWindow(0, -10, 44, 2, 5).start).toBeGreaterThanOrEqual(0);
  });
});

describe("rowOffset", () => {
  it("is linear in the row index", () => {
    expect(rowOffset(0, 44)).toBe(0);
    expect(rowOffset(7, 44)).toBe(308);
    expect(rowOffset(-1, 44)).toBe(0);
  });
});

describe("slotAtCell / columnForSlot snake inverse", () => {
  it("odd rounds run ascending, even rounds descending", () => {
    expect(slotAtCell(1, 0, 12)).toBe(1);
    expect(slotAtCell(1, 11, 12)).toBe(12);
    expect(slotAtCell(2, 0, 12)).toBe(12);
    expect(slotAtCell(2, 11, 12)).toBe(1);
  });

  it("columnForSlot inverts slotAtCell for every round/column (property)", () => {
    for (const teamCount of [4, 8, 10, 12, 14, 16, 20]) {
      for (let round = 1; round <= 25; round++) {
        for (let column = 0; column < teamCount; column++) {
          const slot = slotAtCell(round, column, teamCount);
          expect(columnForSlot(round, slot, teamCount)).toBe(column);
        }
      }
    }
  });

  it("every slot appears exactly once per round", () => {
    for (let round = 1; round <= 4; round++) {
      const slots = Array.from({ length: 12 }, (_, column) => slotAtCell(round, column, 12));
      expect(new Set(slots).size).toBe(12);
    }
  });
});
