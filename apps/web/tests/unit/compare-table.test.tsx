import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CompareTable } from "@/features/players/CompareTable";
import type { PublicPlayerProfile } from "@/lib/server/player-profile";

function makeProfile(overrides: Partial<PublicPlayerProfile>): PublicPlayerProfile {
  return {
    id: "id-1",
    slug: "player-one",
    displayName: "Player One",
    age: 25,
    status: "ACTIVE",
    unsigned: false,
    rookie: false,
    positions: ["PG"],
    team: null,
    projection: {
      games: 70,
      minutesPerGame: 30,
      pts: 20,
      reb: 5,
      ast: 5,
      stl: 1,
      blk: 1,
      tov: 2,
      fgPct: 0.5,
      ftPct: 0.8,
      threePm: 2,
      fantasyPoints: 40,
      overallRank: 10,
      injuryRisk: 0.2,
      consistency: 0.8,
      upside: 0.5,
      roleSecurity: 0.9,
      lower80: {},
      upper80: {},
    },
    adp: null,
    adpDelta: null,
    imageUrl: null,
    draftYear: null,
    historicalSeasons: [],
    strengths: [],
    weaknesses: [],
    projectionRun: null,
    demoData: true,
    ...overrides,
  };
}

describe("CompareTable", () => {
  it("applies a real, separately-tokenized dc-compare-leader class (not concatenated onto the prior class)", () => {
    // Regression test: a missing template-literal space once produced
    // `dc-tabulardc-compare-leader` — a single malformed class that never
    // matched `.dc-compare-leader`'s CSS, silently breaking both the
    // visual highlight and `document.querySelectorAll('.dc-compare-leader')`
    // — found live in a browser, not by typecheck/lint (both passed).
    const low = makeProfile({ id: "low", slug: "low", displayName: "Low Scorer" });
    low.projection = { ...low.projection, pts: 10 };
    const high = makeProfile({ id: "high", slug: "high", displayName: "High Scorer" });
    high.projection = { ...high.projection, pts: 30 };

    const { container } = render(<CompareTable profiles={[low, high]} />);

    const leaderCells = container.querySelectorAll(".dc-compare-leader");
    expect(leaderCells.length).toBeGreaterThan(0);

    for (const cell of leaderCells) {
      expect(cell.classList.contains("dc-compare-leader")).toBe(true);
      expect(cell.className).not.toContain("tabulardc-compare-leader");
    }
  });
});
