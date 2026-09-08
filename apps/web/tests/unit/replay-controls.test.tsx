import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReplayControls } from "@/features/replay/ReplayControls";
import { EventTimeline } from "@/features/replay/EventTimeline";
import { SharedReplay } from "@/features/replay/SharedReplay";
import type { SharedTimelineEntry } from "@/lib/server/share";

/**
 * Phase 3E2 replay UI unit coverage (ADR 0016, M3/M6). Proves:
 * - transport controls render with accessible names and disabled states
 * - scrubber has an explicit name and value text; speed group works
 * - timeline renders a semantic list with current-event marking
 * - shared read-only replay steps through redacted entries only
 */

const noop = () => undefined;

function controlProps(overrides: Partial<Parameters<typeof ReplayControls>[0]> = {}) {
  return {
    position: 2,
    total: 9,
    playing: false,
    speed: 1 as const,
    onFirst: vi.fn(),
    onPrevious: vi.fn(),
    onTogglePlay: vi.fn(),
    onNext: vi.fn(),
    onLast: vi.fn(),
    onSpeedChange: vi.fn(),
    onScrub: vi.fn(),
    ...overrides,
  };
}

describe("ReplayControls", () => {
  it("renders all required transport controls with accessible names", () => {
    render(<ReplayControls {...controlProps()} />);
    expect(screen.getByRole("group", { name: "Draft replay controls" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "First event" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous event" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play replay" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next event" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Last event" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Playback speed" })).toBeInTheDocument();
  });

  it("disables First/Previous at the start and Next/Last at the end", () => {
    const { rerender } = render(<ReplayControls {...controlProps({ position: 0 })} />);
    expect(screen.getByRole("button", { name: "First event" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous event" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next event" })).not.toBeDisabled();
    rerender(<ReplayControls {...controlProps({ position: 8 })} />);
    expect(screen.getByRole("button", { name: "Next event" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Last event" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "First event" })).not.toBeDisabled();
  });

  it("scrubber has an explicit name, value text, and count", () => {
    render(<ReplayControls {...controlProps()} />);
    const scrubber = screen.getByRole("slider", { name: "Replay position" });
    expect(scrubber).toHaveAttribute("aria-valuetext", "Event 3 of 9");
    expect(screen.getByText("Event 3 of 9")).toBeInTheDocument();
  });

  it("play/pause toggles its label and speed buttons report presses", () => {
    const onTogglePlay = vi.fn();
    const onSpeedChange = vi.fn();
    render(<ReplayControls {...controlProps({ playing: true, onTogglePlay, onSpeedChange })} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause replay" }));
    expect(onTogglePlay).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Playback speed 2x" }));
    expect(onSpeedChange).toHaveBeenCalledWith(2);
    expect(screen.getByRole("button", { name: "Playback speed 1x" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("scrubbing reports the target sequence", () => {
    const onScrub = vi.fn();
    render(<ReplayControls {...controlProps({ onScrub })} />);
    fireEvent.change(screen.getByRole("slider", { name: "Replay position" }), {
      target: { value: "5" },
    });
    expect(onScrub).toHaveBeenCalledWith(5);
  });
});

describe("EventTimeline", () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({
    sequence: i + 1,
    description: `Event ${String(i + 1)}`,
    actorType: i === 2 ? "CPU" : "USER",
    eventType: "PLAYER_DRAFTED",
  }));

  it("renders a semantic list with the current event marked", () => {
    render(<EventTimeline entries={entries} position={2} onSelect={noop} />);
    expect(screen.getByRole("list", { name: "Draft event timeline" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByRole("button", { name: /Event 3 \(current\)/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("selecting a row reports its index", () => {
    const onSelect = vi.fn();
    render(<EventTimeline entries={entries} position={0} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Event 4" }));
    expect(onSelect).toHaveBeenCalledWith(3);
  });
});

describe("SharedReplay", () => {
  function sharedEntry(
    sequence: number,
    overrides: Partial<SharedTimelineEntry> = {},
  ): SharedTimelineEntry {
    return {
      sequence,
      eventType: "PLAYER_DRAFTED",
      actorType: "USER",
      description: `Pick event ${String(sequence)}`,
      teamSlot: 1,
      teamName: "My Team",
      playerName: `Player ${String(sequence)}`,
      round: 1,
      pickInRound: sequence,
      overallPick: sequence,
      causationLinked: false,
      undoneAtSequence: null,
      ...overrides,
    };
  }

  const timeline = [sharedEntry(1), sharedEntry(2), sharedEntry(3)];
  const board = [1, 2, 3].map((n) => ({
    overallPick: n,
    round: 1,
    pickInRound: n,
    teamSlot: 1,
    teamName: "My Team",
    playerName: `Player ${String(n)}`,
    slotPosition: "UTIL" as const,
    isKeeper: false,
  }));

  it("loads at the final state and steps backward deterministically", () => {
    render(
      <SharedReplay
        timeline={timeline}
        board={board}
        integrityOk
        integrityDetail="3 effective selections"
      />,
    );
    expect(screen.getByText("Event 3 of 3")).toBeInTheDocument();
    expect(screen.getByText("Player 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous event" }));
    expect(screen.getByText("Event 2 of 3")).toBeInTheDocument();
    expect(screen.queryByText("Player 3")).not.toBeInTheDocument();
    expect(screen.getByText("Player 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "First event" }));
    expect(screen.getByText("Event 1 of 3")).toBeInTheDocument();
  });

  it("hides undone picks at later positions without internal ids", () => {
    const undoneTimeline = [
      sharedEntry(1),
      sharedEntry(2, { playerName: "Undone Player" }),
      { ...sharedEntry(3), eventType: "PICK_UNDONE", playerName: null, causationLinked: true },
      sharedEntry(4, { playerName: "Replacement", overallPick: 2, pickInRound: 2 }),
    ];
    const undoneBoard = [
      {
        overallPick: 1,
        round: 1,
        pickInRound: 1,
        teamSlot: 1,
        teamName: "My Team",
        playerName: "Player 1",
        slotPosition: "UTIL" as const,
        isKeeper: false,
      },
      {
        overallPick: 2,
        round: 1,
        pickInRound: 2,
        teamSlot: 1,
        teamName: "My Team",
        playerName: "Replacement",
        slotPosition: "UTIL" as const,
        isKeeper: false,
      },
    ];
    // Mark the undone pick.
    const markedTimeline = undoneTimeline.map((entry) =>
      entry.playerName === "Undone Player" ? { ...entry, undoneAtSequence: 3 } : entry,
    );
    render(
      <SharedReplay
        timeline={markedTimeline}
        board={undoneBoard}
        integrityOk
        integrityDetail="2 effective selections"
      />,
    );
    // Final state shows the replacement, never the undone player.
    expect(screen.getByText("Replacement")).toBeInTheDocument();
    expect(screen.queryByText("Undone Player")).not.toBeInTheDocument();
    const json = document.body.innerHTML;
    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("Space on a button does not double-toggle; arrows still step", () => {
    render(
      <SharedReplay
        timeline={timeline}
        board={board}
        integrityOk
        integrityDetail="3 effective selections"
      />,
    );
    const play = screen.getByRole("button", { name: "Play replay" });
    // Space keydown on the focused button is ignored (native click covers it).
    fireEvent.keyDown(play, { key: " " });
    expect(screen.getByText("Event 3 of 3")).toBeInTheDocument();
    // Arrow keys step even from a button.
    fireEvent.keyDown(play, { key: "ArrowLeft" });
    expect(screen.getByText("Event 2 of 3")).toBeInTheDocument();
  });

  it("surfaces integrity failure instead of false trust", () => {
    render(
      <SharedReplay
        timeline={timeline}
        board={board}
        integrityOk={false}
        integrityDetail="diverged"
      />,
    );
    expect(screen.getByText(/Replay integrity: FAIL/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
