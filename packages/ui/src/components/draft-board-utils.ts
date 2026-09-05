/**
 * Pure math behind the virtualized visual snake board (Phase 2 acceptance:
 * "Avoid full-board DOM rendering for large drafts"). Kept framework-free so
 * the windowing and snake-order rules are unit/property-testable without
 * React and cannot drift from what the component renders.
 */

export interface VisibleWindow {
  start: number;
  end: number;
}

/**
 * Inclusive row window currently required to fill the viewport. `end` is
 * exclusive-of-total but inclusive in iteration terms (returns at most
 * totalRows rows); `overscan` rows render above and below the visible band
 * so keyboard scrolling never lands on unpainted rows.
 */
export function visibleRowWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number,
  totalRows: number,
): VisibleWindow {
  const safeRowHeight = Math.max(1, rowHeight);
  const safeViewport = Math.max(0, viewportHeight);
  const firstVisible = Math.floor(Math.max(0, scrollTop) / safeRowHeight);
  const visibleCount = Math.ceil(safeViewport / safeRowHeight);
  const start = Math.max(0, firstVisible - Math.max(0, overscan));
  const end = Math.min(totalRows, firstVisible + visibleCount + Math.max(0, overscan));
  return { start, end };
}

/** Absolute top offset of a zero-indexed row inside the scroll content. */
export function rowOffset(rowIndex: number, rowHeight: number): number {
  return Math.max(0, rowIndex) * rowHeight;
}

/**
 * Team slot sitting at `(round, columnIndex)` under snake direction:
 * odd rounds run slot 1→N left-to-right, even rounds run N→1.
 * Both inputs are 1-based except columnIndex (0-based within the round).
 */
export function slotAtCell(round: number, columnIndex: number, teamCount: number): number {
  if (round < 1 || teamCount < 1) return 1;
  const positionInRound = ((round - 1) % 2 === 0 ? columnIndex : teamCount - 1 - columnIndex) + 1;
  return Math.min(teamCount, Math.max(1, positionInRound));
}

/**
 * Column index (0-based) a team occupies in `round`'s snake layout — the
 * inverse of {@link slotAtCell}, used to place the sticky current-pick marker
 * and user-team accents on the right column regardless of direction.
 */
export function columnForSlot(round: number, slot: number, teamCount: number): number {
  const positionInRound = round % 2 === 1 ? slot : teamCount + 1 - slot;
  return Math.min(teamCount - 1, Math.max(0, positionInRound - 1));
}
