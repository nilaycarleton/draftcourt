import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DraftBoard } from "./DraftBoard";

const teams = Array.from({ length: 12 }, (_, index) => ({
  slot: index + 1,
  displayName:
    index === 3 ? "A Very Long Team Name That Must Truncate Safely" : `Team ${String(index + 1)}`,
  isUserTeam: index === 3,
}));

const picks = [
  {
    round: 1,
    pickInRound: 1,
    teamSlot: 1,
    overallPick: 1,
    playerName: "Victor Wembanyama",
    isKeeper: false,
  },
  {
    round: 1,
    pickInRound: 2,
    teamSlot: 2,
    overallPick: 2,
    playerName: "Luka Dončić",
    isKeeper: true,
  },
];

function renderBoard(overrides?: Partial<Parameters<typeof DraftBoard>[0]>): void {
  const props = {
    teams,
    rounds: 13,
    picks,
    currentOverallPick: 3,
    onAnnounce: vi.fn(),
    ...overrides,
  } as Parameters<typeof DraftBoard>[0];
  render(<DraftBoard {...props} />);
}

describe("DraftBoard", () => {
  it("renders the header row for every team plus a sticky round gutter", () => {
    renderBoard();
    expect(screen.getByRole("grid")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(12);
    expect(screen.getByTestId("dc-board-round-1")).toBeInTheDocument();
  });

  it("shows drafted players and keeper badges in their snake cells", () => {
    renderBoard();
    expect(screen.getByText("Victor Wembanyama")).toBeInTheDocument();
    // Keeper badge is text ("K") with an accessible label — never color alone.
    expect(screen.getByLabelText("keeper")).toBeInTheDocument();
  });

  it("marks exactly one cell as the current pick", () => {
    renderBoard();
    const current = document.querySelectorAll("[data-current]");
    expect(current).toHaveLength(1);
    const first = current[0];
    if (!first) throw new Error("no current cell");
    expect(first.getAttribute("data-testid")).toBe("dc-board-cell-r1c3");
  });

  it("virtualizes: only a window of rounds is in the DOM for tall drafts", () => {
    render(<DraftBoard teams={teams} rounds={25} picks={[]} currentOverallPick={301} />);
    const rows = document.querySelectorAll('[role="row"]:not([aria-rowindex="1"])');
    // jsdom viewport (ResizeObserver fallback) renders a bounded window, not 25.
    expect(rows.length).toBeLessThan(25);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("moves the aria-activedescendant cursor with arrow keys and announces cells", async () => {
    const onAnnounce = vi.fn();
    renderBoard({ onAnnounce });
    const grid = screen.getByRole("grid");
    grid.focus();
    expect(grid.getAttribute("aria-activedescendant")).toMatch(/dc-board-cell-0-/);
    await userEvent.keyboard("{ArrowDown}");
    expect(grid.getAttribute("aria-activedescendant")).toMatch(/dc-board-cell-1-/);
    expect(onAnnounce).toHaveBeenCalled();
  });

  it("opens a team roster from the column header without navigating away", async () => {
    const onOpenTeamRoster = vi.fn();
    renderBoard({ onOpenTeamRoster });
    let teamButton: HTMLElement | undefined;
    for (const button of screen.getAllByRole("button")) {
      if (button.textContent.includes("Team 6")) {
        teamButton = button;
        break;
      }
    }
    if (!teamButton) throw new Error("Team 6 header button not rendered");
    await userEvent.click(teamButton);
    expect(onOpenTeamRoster).toHaveBeenCalledWith(6);
  });

  it("truncates long team names in headers via title tooltip, not wrapping drift", () => {
    renderBoard();
    let longTitle: string | null = null;
    for (const header of screen.getAllByRole("columnheader")) {
      if (header.textContent.includes("Very Long Team Name")) {
        longTitle = header.querySelector("button")?.getAttribute("title") ?? null;
      }
    }
    expect(longTitle).toContain("Must Truncate");
  });

  it("keeps the board keyboard-scrollable but disables roster buttons when read-only", () => {
    renderBoard({ readOnly: true });
    const grid = screen.getByRole("grid");
    // Scrolling must stay possible without a pointer (axe
    // scrollable-region-focusable), even for completed drafts.
    expect(grid.getAttribute("tabindex")).toBe("0");
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByText("Victor Wembanyama")).toBeInTheDocument();
  });
});
