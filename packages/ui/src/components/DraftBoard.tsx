"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { columnForSlot, rowOffset, slotAtCell, visibleRowWindow } from "./draft-board-utils";

/**
 * Virtualized visual snake board (BUILD_SPEC.md section 9.2; Impeccable shape:
 * docs/design/phase2-shape.md). Renders only the rows near the viewport — a
 * full 20-team × 25-round board never materializes its whole DOM. The
 * semantic per-pick alternative for assistive technology lives in the draft
 * room (feature layer), not here.
 *
 * Keyboard model: one tab stop on the scroll container; arrow keys move an
 * `aria-activedescendant` cursor across rendered cells, scrolling first when
 * the target row is outside the window — so windowing cannot strand focus.
 * Picks and state changes are announced by the room's shared polite live
 * region via `onAnnounce`, not by per-cell live regions (no SR flooding).
 */

export interface DraftBoardTeam {
  slot: number;
  displayName: string;
  isUserTeam: boolean;
}

export interface DraftBoardPick {
  round: number;
  pickInRound: number;
  teamSlot: number;
  overallPick: number;
  playerName: string;
  isKeeper: boolean;
}

export interface DraftBoardProps {
  teams: DraftBoardTeam[];
  rounds: number;
  /** Effective selections only (undone picks are absent). */
  picks: DraftBoardPick[];
  /** Next overall pick to be made (1-based). */
  currentOverallPick: number;
  /** Read-only drafts disable the roster affordances but keep the data. */
  readOnly?: boolean;
  onOpenTeamRoster?: (slot: number) => void;
  onAnnounce?: (message: string) => void;
  labelId?: string;
}

const ROW_HEIGHT = 44;
const HEADER_HEIGHT = 44;
const OVERSCAN_ROWS = 3;

interface CellModel {
  round: number;
  columnIndex: number;
  teamSlot: number;
  pick: DraftBoardPick | null;
  isCurrent: boolean;
  /** Overall pick number this team holds in this round (snake-aware). */
  openNumber: number;
}

function buildCellIndex(picks: DraftBoardPick[]): Map<string, DraftBoardPick> {
  const index = new Map<string, DraftBoardPick>();
  for (const pick of picks) {
    // Columns are fixed to team slots, so a cell is identified by
    // (round, teamSlot) — never by pick-in-round, which would place
    // players under the wrong manager once the snake reverses.
    index.set(`${String(pick.round)}:${String(pick.teamSlot)}`, pick);
  }
  return index;
}

export function DraftBoard({
  teams,
  rounds,
  picks,
  currentOverallPick,
  readOnly = false,
  onOpenTeamRoster,
  onAnnounce,
  labelId,
}: DraftBoardProps) {
  const teamCount = Math.max(1, teams.length);
  const totalRounds = Math.max(1, rounds);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollInitialized = useRef(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(ROW_HEIGHT * 10);

  const cellByPosition = useMemo(() => buildCellIndex(picks), [picks]);

  const currentRound = Math.min(
    totalRounds,
    Math.max(1, Math.ceil(currentOverallPick / teamCount)),
  );
  const currentPositionInRound = ((currentOverallPick - 1) % teamCount) + 1;
  const currentSlot = slotAtCell(currentRound, currentPositionInRound - 1, teamCount);

  // Cursor position as [rowIndex, columnIndex]; focus stays on the grid
  // container while aria-activedescendant points at the cursor cell. It
  // starts at the current pick.
  const [cursor, setCursor] = useState<{ row: number; column: number }>(() => ({
    row: Math.min(totalRounds - 1, Math.max(0, currentRound - 1)),
    column: columnForSlot(currentRound, currentSlot, teamCount),
  }));

  const window_ = visibleRowWindow(
    scrollTop,
    viewportHeight,
    ROW_HEIGHT,
    OVERSCAN_ROWS,
    totalRounds,
  );

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    const update = (): void => {
      scrollInitialized.current = true;
      setScrollTop(element.scrollTop);
      setViewportHeight(element.clientHeight);
    };
    // Initial measure happens off the effect's synchronous path (the
    // react-hooks `set-state-in-effect` rule) — one frame later is
    // indistinguishable for a scroll container.
    const raf = requestAnimationFrame(update);
    element.addEventListener("scroll", update, { passive: true });
    // ResizeObserver is universally available in browsers; the guard keeps
    // jsdom-based tests and exotic embedded webviews working.
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(update);
      observer.observe(element);
      return () => {
        cancelAnimationFrame(raf);
        element.removeEventListener("scroll", update);
        observer.disconnect();
      };
    }
    return () => {
      cancelAnimationFrame(raf);
      element.removeEventListener("scroll", update);
    };
  }, []);

  // Cursor starts at the current pick and follows it whenever it advances
  // (new draft or reload). Adjusting state during render for a changed prop
  // is the documented React "derive state from props change" pattern — no
  // effect, no cascading render pass.
  const [followedPick, setFollowedPick] = useState(currentOverallPick);
  if (followedPick !== currentOverallPick) {
    setFollowedPick(currentOverallPick);
    setCursor({
      row: currentRound - 1,
      column: columnForSlot(currentRound, currentSlot, teamCount),
    });
  }

  // DOM side-effect only (no state): keep the followed cell within view.
  const followedRow = currentRound - 1;
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !scrollInitialized.current) return;
    const top = rowOffset(followedRow, ROW_HEIGHT);
    if (top < element.scrollTop || top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - element.clientHeight / 2 + ROW_HEIGHT / 2);
    }
  }, [followedRow]);

  const moveCursor = useCallback(
    (deltaRow: number, deltaColumn: number): void => {
      setCursor((previous) => {
        const row = Math.min(totalRounds - 1, Math.max(0, previous.row + deltaRow));
        const column = Math.min(teamCount - 1, Math.max(0, previous.column + deltaColumn));
        return { row, column };
      });
    },
    [teamCount, totalRounds],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const deltas: Record<string, [number, number]> = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
      };
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        setCursor((previous) => ({
          row: previous.row,
          column: event.key === "Home" ? 0 : teamCount - 1,
        }));
        return;
      }
      const delta = deltas[event.key];
      if (!delta) return;
      event.preventDefault();
      moveCursor(delta[0], delta[1]);
    },
    [moveCursor, teamCount],
  );

  const rows: { round: number; cells: CellModel[] }[] = [];
  // Board model: every COLUMN is one draft team (fixed order matching the
  // headers); a cell shows that team's pick in the row's round. The snake
  // direction lives in WHICH pick number each team holds per round —
  // positionInRound flips on even rounds — not in moving players across
  // columns.
  const positionForSlot = (round: number, slot: number): number =>
    (round - 1) % 2 === 0 ? slot : teamCount + 1 - slot;
  const openPickNumber = (round: number, slot: number): number =>
    (round - 1) * teamCount + positionForSlot(round, slot);
  for (let round = window_.start + 1; round <= window_.end; round++) {
    const cells: CellModel[] = [];
    for (let columnIndex = 0; columnIndex < teamCount; columnIndex++) {
      const teamSlot = columnIndex + 1;
      const pick = cellByPosition.get(`${String(round)}:${String(teamSlot)}`) ?? null;
      cells.push({
        round,
        columnIndex,
        teamSlot,
        pick,
        isCurrent:
          round === currentRound &&
          teamSlot === slotAtCell(currentRound, currentPositionInRound - 1, teamCount),
        openNumber: openPickNumber(round, teamSlot),
      });
    }
    rows.push({ round, cells });
  }

  // Sticky round gutter column + one snake column per team; inline because
  // the count is data-driven (4–20 teams).
  const gridTemplateColumns = `2.25rem repeat(${String(teamCount)}, minmax(7.5rem, 1fr))`;

  return (
    <div className="dc-board-shell">
      <div
        ref={scrollRef}
        className="dc-board-scroll"
        data-testid="dc-board-scroll"
        // Always keyboard-scrollable, including read-only/completed drafts
        // (axe: scrollable-region-focusable).
        tabIndex={0}
        role="grid"
        aria-labelledby={labelId}
        aria-rowcount={totalRounds + 1}
        aria-colcount={teamCount}
        aria-activedescendant={`dc-board-cell-${String(cursor.row)}-${String(cursor.column)}`}
        onKeyDown={onKeyDown}
      >
        <div
          className="dc-board-canvas"
          style={{ height: `${String(HEADER_HEIGHT + totalRounds * ROW_HEIGHT)}px` }}
        >
          <div
            className="dc-board-header-row"
            style={{ top: 0, gridTemplateColumns }}
            role="row"
            aria-rowindex={1}
          >
            {/* Corner cell keeps headers aligned with the body's round gutter. */}
            <div className="dc-board-corner" aria-hidden="true">
              #
            </div>
            {teams.map((team, columnIndex) => (
              <div
                key={team.slot}
                role="columnheader"
                id={`dc-board-head-${String(columnIndex)}`}
                aria-colindex={columnIndex + 1}
                className={["dc-board-team-head", team.isUserTeam ? "dc-board-team-user" : ""].join(
                  " ",
                )}
              >
                <button
                  type="button"
                  title={team.displayName}
                  disabled={readOnly || !onOpenTeamRoster}
                  onClick={() => {
                    onOpenTeamRoster?.(team.slot);
                  }}
                >
                  <span className="dc-board-slot">{String(team.slot)}</span>
                  <span className="dc-board-team-name">{team.displayName}</span>
                </button>
              </div>
            ))}
          </div>
          {rows.map(({ round, cells }) => (
            <div
              key={round}
              role="row"
              aria-rowindex={round + 1}
              className={round % 2 === 0 ? "dc-board-row dc-board-row-even" : "dc-board-row"}
              style={{
                top: `${String(rowOffset(round - 1, ROW_HEIGHT) + HEADER_HEIGHT)}px`,
                gridTemplateColumns,
              }}
            >
              <span
                className="dc-board-round-cell"
                aria-hidden="true"
                data-testid={`dc-board-round-${String(round)}`}
              >
                {String(round)}
              </span>
              {cells.map((cell) => {
                const team = teams.find((t) => t.slot === cell.teamSlot);
                const id = `dc-board-cell-${String(cell.round - 1)}-${String(cell.columnIndex)}`;
                const classes = [
                  "dc-board-cell",
                  cell.isCurrent ? "dc-board-cell-current" : "",
                  team?.isUserTeam ? "dc-board-cell-user" : "",
                  cell.pick ? "dc-board-cell-drafted" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <span
                    key={[cell.teamSlot, cell.columnIndex].join("-")}
                    id={id}
                    role="gridcell"
                    aria-colindex={cell.columnIndex + 1}
                    aria-selected={
                      cursor.row === cell.round - 1 && cursor.column === cell.columnIndex
                    }
                    data-current={cell.isCurrent || undefined}
                    data-testid={`dc-board-cell-r${String(cell.round)}c${String(cell.columnIndex + 1)}`}
                    className={classes}
                    title={
                      cell.pick
                        ? `${cell.pick.playerName} — ${team?.displayName ?? String(cell.teamSlot)}${cell.pick.isKeeper ? " (keeper)" : ""}`
                        : undefined
                    }
                  >
                    {cell.pick ? (
                      <>
                        <span className="dc-board-player">{cell.pick.playerName}</span>
                        {cell.pick.isKeeper && (
                          <span className="dc-board-keeper" aria-label="keeper">
                            K
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="dc-board-open">{String(cell.openNumber)}</span>
                    )}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {/* Cursor announcement helper: mirrors activedescendant text into the
          room's live region after keyboard moves. */}
      <CursorReporter
        cursor={cursor}
        getCell={(row, column) => {
          const round = row + 1;
          // Columns are fixed to teams: the cell at `column` belongs to the
          // team whose header sits there (columnIndex + 1).
          const teamSlot = column + 1;
          const pick = cellByPosition.get(`${String(round)}:${String(teamSlot)}`) ?? null;
          return { round, teamSlot, pick };
        }}
        teams={teams}
        onAnnounce={onAnnounce}
      />
    </div>
  );
}

interface CursorReporterProps {
  cursor: { row: number; column: number };
  getCell: (
    row: number,
    column: number,
  ) => { round: number; teamSlot: number; pick: DraftBoardPick | null };
  teams: DraftBoardTeam[];
  onAnnounce?: ((message: string) => void) | undefined;
}

/** Announces the cell under the cursor only after explicit keyboard moves
 * (not during scroll-driven re-renders). */
function CursorReporter({ cursor, getCell, teams, onAnnounce }: CursorReporterProps): null {
  const previous = useRef(cursor);
  useEffect(() => {
    if (!onAnnounce) return;
    if (previous.current.row === cursor.row && previous.current.column === cursor.column) return;
    previous.current = cursor;
    const cell = getCell(cursor.row, cursor.column);
    const team = teams.find((t) => t.slot === cell.teamSlot);
    if (cell.pick) {
      onAnnounce(
        `Round ${String(cell.round)}: ${cell.pick.playerName}, ${team?.displayName ?? String(cell.teamSlot)}${cell.pick.isKeeper ? ", keeper" : ""}.`,
      );
    } else {
      onAnnounce(`Round ${String(cell.round)}, ${team?.displayName ?? ""}: open.`);
    }
  }, [cursor, getCell, onAnnounce, teams]);
  return null;
}
