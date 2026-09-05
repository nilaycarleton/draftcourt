import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  StrategyEvidenceCard,
  type DraftRoomStrategyEvidence,
} from "@/features/drafts/StrategyEvidenceCard";

/**
 * Draft-room evidence card unit coverage (Phase 3B): the four provenance
 * labels, full sheet contents (versions/checksum/punts/influences/edit link/
 * immutability sentence), INVALID degradation, absent → renders nothing, and
 * no mutating inputs anywhere.
 */

function evidence(overrides: Partial<DraftRoomStrategyEvidence> = {}): DraftRoomStrategyEvidence {
  return {
    status: "OK",
    source: {
      kind: "LEAGUE_SELECTION",
      profileId: "pp-1",
      profileName: "Win Now",
      presetKey: "win-now",
      presetVersion: 1,
    },
    snapshotVersion: 2,
    preferenceSchemaVersion: 1,
    checksum: "deadbeefcafe0123456789",
    capturedAt: "2026-08-24T12:00:00.000Z",
    engineVersion: "phase3-preferences-1.0.0",
    settingsSummary: {
      topFactors: [
        { key: "production", weight: 0.42 },
        { key: "risk", weight: 0.18 },
        { key: "preference", weight: 0.05 },
      ],
      punts: ["TOV", "BLK"],
      avoidMode: "SEVERE_PENALTY",
      scheduleEnabled: true,
      favoritePlayers: 2,
      dislikedPlayers: 1,
      targetPlayers: 3,
      avoidedPlayers: 4,
      teamPreferences: 1,
      customRanks: 12,
    },
    ...overrides,
  };
}

describe("StrategyEvidenceCard provenance badges", () => {
  const cases: [string, string][] = [
    ["USER_DEFAULT", "User default"],
    ["LEAGUE_SELECTION", "League selection"],
    ["DRAFT_OVERRIDE", "Draft override"],
    ["DRAFTCOURT_DEFAULTS", "DraftCourt defaults"],
  ];
  for (const [kind, label] of cases) {
    it(`maps ${kind} to “${label}”`, () => {
      render(
        <StrategyEvidenceCard
          strategy={evidence({
            source: {
              kind,
              profileId: null,
              profileName: kind === "DRAFTCOURT_DEFAULTS" ? null : "P",
              presetKey: null,
              presetVersion: null,
            },
          })}
        />,
      );
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText(/Locked at draft start/)).toBeInTheDocument();
    });
  }
});

describe("StrategyEvidenceCard details sheet", () => {
  it("reveals factor weights, punts, avoid behavior, influences, versions, checksum, capture date, edit link and immutability sentence", async () => {
    render(<StrategyEvidenceCard strategy={evidence()} />);
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();

    // Factor weights table with human labels + tabular value cells.
    expect(screen.getByText("Projected production")).toBeInTheDocument();
    expect(screen.getByText("0.420")).toBeInTheDocument();
    expect(screen.getByText("Personal preference")).toBeInTheDocument();

    // Punt list.
    expect(screen.getByText("TOV")).toBeInTheDocument();
    expect(screen.getByText("BLK")).toBeInTheDocument();

    // Avoid behavior wording for SEVERE_PENALTY.
    expect(screen.getByText(/Severe penalty/)).toBeInTheDocument();

    // Influence counts.
    expect(screen.getByText("Favorite players")).toBeInTheDocument();
    expect(screen.getByText("Custom ranks")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();

    // Provenance: engine version, snapshot version, short checksum, date.
    expect(screen.getAllByText(/phase3-preferences-1\.0\.0/).length).toBeGreaterThan(0);
    const snapshotRow = screen.getByText("Snapshot version").closest("tr");
    expect(snapshotRow?.textContent).toContain("2");
    expect(screen.getByText("deadbeefca")).toBeInTheDocument(); // short, not full
    expect(screen.queryByText("deadbeefcafe0123456789")).toBeNull();
    expect(screen.getByText("2026-08-24")).toBeInTheDocument();

    // Future-drafts link + immutability sentence.
    expect(screen.getByRole("link", { name: "Edit for future drafts" })).toHaveAttribute(
      "href",
      "/preferences",
    );
    expect(screen.getByText(/This draft.s strategy cannot be edited\./)).toBeInTheDocument();

    // Close restores focus to the invoking Details button (roster-sheet
    // contract): prefer an explicit close control, else Escape.
    const closeButton = screen.queryByRole("button", { name: /close/i });
    if (closeButton) {
      await userEvent.click(closeButton);
    } else {
      await userEvent.keyboard("{Escape}");
    }
    await waitFor(() => {
      const remaining = screen.queryByRole("dialog");
      if (remaining) expect(remaining).not.toHaveAttribute("open");
      else expect(remaining).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Details" })).toHaveFocus();
    });
  });

  it("words EXCLUDE mode as excluded entirely", async () => {
    const base = evidence();
    if (!base.settingsSummary) throw new Error("fixture missing summary");
    render(
      <StrategyEvidenceCard
        strategy={{
          ...base,
          settingsSummary: { ...base.settingsSummary, avoidMode: "EXCLUDE" },
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByText(/Excluded entirely/)).toBeInTheDocument();
  });

  it("contains no inputs that could mutate strategy", async () => {
    render(<StrategyEvidenceCard strategy={evidence()} />);
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    await screen.findByRole("dialog");
    expect(document.querySelectorAll(".dc-evidence-card input").length).toBe(0);
    expect(
      document.querySelectorAll(
        ".dc-evidence-sheet input, .dc-evidence-sheet select, .dc-evidence-sheet textarea",
      ).length,
    ).toBe(0);
  });
});

describe("StrategyEvidenceCard degraded states", () => {
  it("shows the honest warning strip for INVALID status without a details affordance", () => {
    render(<StrategyEvidenceCard strategy={evidence({ status: "INVALID" })} />);
    expect(screen.getByText(/Stored strategy snapshot could not be read\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
  ])("renders nothing when strategy is %s", (_label, absent) => {
    const { container } = render(<StrategyEvidenceCard strategy={absent} />);
    expect(container.querySelector(".dc-evidence-card")).toBeNull();
  });
});
