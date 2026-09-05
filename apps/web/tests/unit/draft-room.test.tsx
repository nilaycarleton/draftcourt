import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DraftRoom } from "@/features/drafts/DraftRoom";
import type { DraftRoomStrategyEvidence } from "@/features/drafts/StrategyEvidenceCard";

/**
 * DraftRoom unit coverage for the Phase 2 acceptance items that do not need
 * a real draft: explicit mobile tabs, the virtualized board integration, the
 * semantic board data table, opponent roster sheet focus restoration, and
 * keyboard shortcut → tab activation.
 */

const initial = {
  version: 3,
  status: "ACTIVE",
  nextOverallPick: 4,
  currentSequence: 5,
  boardSize: 24,
  settingsSnapshot: {
    teamCount: 12,
    rounds: 2,
    userDraftSlot: 4,
    scoringRules: [{ stat: "PTS", weight: 1 }],
    teams: Array.from({ length: 12 }, (_, index) => ({
      slot: index + 1,
      displayName:
        index === 5 ? "Long Opponent Team Name That Truncates" : `Team ${String(index + 1)}`,
      isUserTeam: index === 3,
    })),
  },
  teams: [
    {
      slot: 1,
      displayName: "Team 1",
      isUserTeam: false,
      assignments: [
        {
          playerId: "p-1",
          playerName: "Victor Wembanyama",
          sequence: 1,
          round: 1,
          pickInRound: 1,
          isKeeper: false,
        },
        {
          playerId: "p-2",
          playerName: "Luka Dončić",
          sequence: 13,
          round: 2,
          pickInRound: 1,
          isKeeper: true,
        },
      ],
    },
    {
      slot: 4,
      displayName: "Team 4",
      isUserTeam: true,
      assignments: [
        {
          playerId: "p-3",
          playerName: "Shai Gilgeous-Alexander",
          sequence: 6,
          round: 1,
          pickInRound: 6,
          isKeeper: false,
        },
      ],
    },
  ],
};

const fetchCalls: { url: string; init?: RequestInit | undefined }[] = [];

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      let body: unknown = { data: [] };
      if (url.includes("/recommendations")) {
        body = { data: { top3: [], engineVersion: "test", inputChecksum: "abc" } };
      } else if (url.includes("/api/v1/players")) {
        body = {
          data: [
            { id: "p-9", displayName: "Nikola Jokić" },
            { id: "p-8", displayName: "Giannis Antetokounmpo" },
          ],
        };
      } else if (url.includes("/api/v1/drafts/")) {
        body = {
          data: {
            version: initial.version,
            status: initial.status,
            nextOverallPick: initial.nextOverallPick,
            currentSequence: initial.currentSequence,
            teams: initial.teams,
          },
        };
      }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }),
  );
}

beforeEach(() => {
  fetchCalls.length = 0;
  vi.unstubAllGlobals();
  stubFetch();
});

function renderRoom(): void {
  render(<DraftRoom draftId="d-1" initial={initial} />);
}

describe("DraftRoom mobile tabs", () => {
  it("renders all four section panels with their tab labels", () => {
    renderRoom();
    expect(screen.getByRole("tabpanel", { name: "Top three recommendations" })).toBeInTheDocument();
    expect(screen.getByLabelText("Available players")).toBeInTheDocument();
    expect(screen.getByLabelText("My roster")).toBeInTheDocument();
    expect(screen.getAllByText("Board").length).toBeGreaterThan(0);
  });

  it("keeps panels mounted when the active tab changes (state survives)", async () => {
    renderRoom();
    // Desktop default: nothing hidden.
    expect(screen.getByLabelText("Available players")).not.toHaveClass("dc-tab-hidden");
    // Simulate switching to players via tab click.
    await userEvent.click(screen.getByRole("tab", { name: /Available players/ }));
    // jsdom matchMedia never matches mobile; desktop keeps every panel visible.
    expect(screen.getByRole("tabpanel", { name: "Top three recommendations" })).toBeVisible();
  });

  it("activates the matching tab on R / B / M keyboard shortcuts", async () => {
    renderRoom();
    await userEvent.keyboard("b");
    expect(screen.getByRole("tab", { name: "Board" }).getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("r");
    const recTab = screen.getAllByRole("tab", { name: "Recommendations" }).at(0);
    if (!recTab) throw new Error("recommendations tab missing");
    expect(recTab.getAttribute("aria-selected")).toBe("true");
  });
});

describe("DraftRoom board", () => {
  it("renders the virtualized snake grid with drafted names and keepers", () => {
    renderRoom();
    expect(screen.getByText("Victor Wembanyama")).toBeInTheDocument();
    expect(screen.getByText("Shai Gilgeous-Alexander")).toBeInTheDocument();
    expect(screen.getByLabelText("keeper")).toBeInTheDocument();
  });

  it("offers a semantic per-pick table alternative rendered lazily on expand", async () => {
    renderRoom();
    // Collapsed by default: no full second copy of the picks in the DOM.
    expect(document.querySelector(".dc-board-data table")).toBeNull();
    await userEvent.click(screen.getByText(/Board data table/));
    await waitFor(() => {
      expect(
        screen.getByRole("table", { name: /Every selection by overall pick/ }),
      ).toBeInTheDocument();
    });
    const tableCells = screen.getAllByText("Victor Wembanyama");
    expect(tableCells.length).toBeGreaterThanOrEqual(1);
  });

  it("opens an opponent roster sheet from a team header without losing room state", async () => {
    renderRoom();
    const headerButton = screen
      .getAllByRole("button")
      .find((button) => button.textContent.includes("Team 1"));
    if (!headerButton) throw new Error("team header missing");
    await userEvent.click(headerButton);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // Room state (search text) survives behind the sheet.
    const searchBox = screen.getByPlaceholderText("Press / to search");
    await userEvent.type(searchBox, "wem");
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
    const searchAfterClose = screen.getByPlaceholderText(
      "Press / to search",
    ) as HTMLInputElement | null;
    if (!searchAfterClose) throw new Error("search input missing");
    expect(searchAfterClose.value).toBe("wem");
  });
});

describe("DraftRoom pick flow", () => {
  it("posts a pick with idempotency/version headers then re-syncs the board", async () => {
    renderRoom();
    await screen.findByDisplayValue("");
    await waitFor(() => {
      const draftButtons = screen
        .getAllByRole("button")
        .filter((button) => button.textContent === "Draft");
      expect(draftButtons.length).toBeGreaterThan(0);
    });
    const firstDraftButton = screen
      .getAllByRole("button")
      .find((button) => button.textContent === "Draft");
    if (!firstDraftButton) throw new Error("no Draft button rendered");
    await userEvent.click(firstDraftButton);
    await waitFor(() => {
      expect(fetchCalls.some((call) => call.url.includes("/picks"))).toBe(true);
    });
    const pickCall = fetchCalls.find((call) => call.url.includes("/picks"));
    expect(pickCall?.init?.headers).toMatchObject({
      "If-Match": "3",
    });
    // Authoritative read model is refetched after the mutation.
    await waitFor(() => {
      expect(fetchCalls.filter((call) => call.url.endsWith("/drafts/d-1")).length).toBeGreaterThan(
        0,
      );
    });
  });

  it("requires a second Undo activation before posting (armed confirmation)", async () => {
    renderRoom();
    const undo = () => screen.getByRole("button", { name: /undo/i });
    await userEvent.click(undo());
    // Armed: visible label change + announcement, and NO undo request yet.
    expect(undo().textContent).toBe("Confirm undo");
    expect(undo()).toHaveAttribute("data-armed");
    await waitFor(() => {
      const region = document.querySelector('[aria-live="polite"]');
      expect(region?.textContent).toContain("Press again to undo");
    });
    expect(fetchCalls.some((call) => call.url.includes("/undo"))).toBe(false);
    // Second activation confirms: exactly one undo request, announced.
    await userEvent.click(undo());
    await waitFor(() => {
      const region = document.querySelector('[aria-live="polite"]');
      expect(region?.textContent).toContain("undone");
    });
    expect(fetchCalls.filter((call) => call.url.includes("/undo"))).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Undo" }).textContent).toBe("Undo");
  });

  it("disarms an armed Undo on Escape without posting", async () => {
    renderRoom();
    const undo = () => screen.getByRole("button", { name: /undo/i });
    await userEvent.click(undo());
    expect(undo().textContent).toBe("Confirm undo");
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Undo" }).textContent).toBe("Undo");
    expect(fetchCalls.some((call) => call.url.includes("/undo"))).toBe(false);
  });

  it("uses the same armed confirmation for the U keyboard shortcut", async () => {
    renderRoom();
    await userEvent.keyboard("u");
    expect(screen.getByRole("button", { name: "Confirm undo" })).toBeInTheDocument();
    expect(fetchCalls.some((call) => call.url.includes("/undo"))).toBe(false);
    await userEvent.keyboard("u");
    await waitFor(() => {
      const region = document.querySelector('[aria-live="polite"]');
      expect(region?.textContent).toContain("undone");
    });
    expect(fetchCalls.filter((call) => call.url.includes("/undo"))).toHaveLength(1);
  });

  it("shares armed state across pointer and keyboard paths (no double execution)", async () => {
    renderRoom();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    // Keyboard confirm of a pointer-armed undo executes exactly once.
    await userEvent.keyboard("u");
    await waitFor(() => {
      expect(fetchCalls.filter((call) => call.url.includes("/undo"))).toHaveLength(1);
    });
    // A further click re-arms instead of executing again (armed state was
    // cleared by the confirmation).
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Confirm undo" })).toBeInTheDocument();
    expect(fetchCalls.filter((call) => call.url.includes("/undo"))).toHaveLength(1);
  });

  it("disables mutations in completed drafts (read-only)", () => {
    render(<DraftRoom draftId="d-1" initial={{ ...initial, status: "COMPLETED" }} />);
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    for (const button of screen.getAllByRole("button")) {
      if (button.textContent === "Draft") expect(button).toBeDisabled();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3B (additive): strategy evidence strip, contribution chips, warnings.
// ---------------------------------------------------------------------------

const strategyFixture: DraftRoomStrategyEvidence = {
  status: "OK",
  source: {
    kind: "DRAFT_OVERRIDE",
    profileId: "pp-9",
    profileName: "Playoff Punt Special",
    presetKey: null,
    presetVersion: null,
  },
  snapshotVersion: 2,
  preferenceSchemaVersion: 1,
  checksum: "cafebabedeadbeef1234",
  capturedAt: "2026-08-24T09:30:00.000Z",
  engineVersion: "phase3-preferences-1.0.0",
  settingsSummary: {
    topFactors: [
      { key: "production", weight: 0.4 },
      { key: "preference", weight: 0.05 },
    ],
    punts: ["TOV"],
    avoidMode: "EXCLUDE",
    scheduleEnabled: true,
    favoritePlayers: 1,
    dislikedPlayers: 2,
    targetPlayers: 0,
    avoidedPlayers: 3,
    teamPreferences: 0,
    customRanks: 5,
  },
};

const componentStub = [
  {
    key: "production",
    raw: 0.8,
    normalized: 0.9,
    weight: 0.3,
    contribution: 0.087,
    reason: "blended projected points percentile",
  },
  {
    key: "risk",
    raw: 0.2,
    normalized: 0.2,
    weight: 0.1,
    contribution: -0.062,
    reason: "safety from injury risk",
  },
  {
    key: "preference",
    raw: 0,
    normalized: 0,
    weight: 0.05,
    contribution: 0,
    reason: "your preference lists did not move this player",
  },
];

/** Records URLs routed through the Phase 3B describe-local fetch mock. */
const recordedUrls: string[] = [];

function stubRoomWithStrategyRecs(): void {
  recordedUrls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = String(input);
      recordedUrls.push(url);
      let body: unknown = { data: [] };
      if (url.includes("/recommendations")) {
        body = {
          data: {
            engineVersion: "test",
            inputChecksum: "abc",
            top3: [
              {
                playerId: "rec-1",
                displayName: "Nikola Jokić",
                draftScore: 91.5,
                labels: ["BEST_OVERALL"],
                explanation: "top blend",
                confidence: "HIGH",
                components: componentStub,
                availabilityNextPick: 0.9,
                lookaheadBonus: 0,
                warnings: ["Preference reach: market ADP 31 picks beyond your current pick."],
              },
              {
                playerId: "p-9",
                displayName: "Giannis Antetokounmpo",
                draftScore: 88.0,
                labels: [],
                explanation: "solid",
                confidence: "HIGH",
                components: componentStub.map((c) => ({ ...c })),
                availabilityNextPick: 0.8,
                lookaheadBonus: 0,
              },
            ],
          },
        };
      } else if (url.includes("/api/v1/players")) {
        body = {
          data: [
            { id: "p-9", displayName: "Giannis Antetokounmpo" },
            { id: "p-7", displayName: "Jayson Tatum" },
          ],
        };
      } else if (url.includes("/api/v1/drafts/d-1/picks")) {
        body = { data: { authoritative: { nextOverallPick: 5, version: 4 } } };
      } else if (url.includes("/api/v1/drafts/d-1/undo")) {
        body = { data: { authoritative: { nextOverallPick: 4, version: 5 } } };
      } else if (url.includes("/api/v1/drafts/d-1")) {
        body = {
          data: {
            version: initial.version,
            status: initial.status,
            nextOverallPick: initial.nextOverallPick,
            currentSequence: initial.currentSequence,
            teams: initial.teams,
          },
        };
      }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }),
  );
}

describe("DraftRoom strategy evidence (Phase 3B)", () => {
  beforeEach(() => {
    stubRoomWithStrategyRecs();
  });

  function politeRegion(): HTMLElement | null {
    return document.querySelector('[aria-live="polite"]');
  }

  it("renders the optional strategy strip between status bar and tabs", () => {
    render(<DraftRoom draftId="d-1" initial={{ ...initial, strategy: strategyFixture }} />);
    expect(screen.getByText("Draft override")).toBeInTheDocument();
    expect(screen.getByText("Playoff Punt Special")).toBeInTheDocument();
    expect(screen.getByText(/Locked at draft start/)).toBeInTheDocument();
  });

  it("renders nothing when strategy is absent (pre-3B drafts)", () => {
    render(<DraftRoom draftId="d-1" initial={initial} />);
    expect(document.querySelector(".dc-evidence-card")).toBeNull();
    expect(screen.queryByText(/Locked at draft start/)).toBeNull();
  });

  it("renders INVALID strategy as an honest degraded strip without Details", () => {
    render(
      <DraftRoom
        draftId="d-1"
        initial={{
          ...initial,
          strategy: { ...strategyFixture, status: "INVALID", settingsSummary: null },
        }}
      />,
    );
    expect(screen.getByText(/Stored strategy snapshot could not be read\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  });

  it("shows top signed contributor chips from stubbed components plus the honest zero-preference chip", async () => {
    render(<DraftRoom draftId="d-1" initial={{ ...initial, strategy: strategyFixture }} />);
    const chips = await screen.findAllByText(/^[+−]?\d/);
    expect(chips.length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\+8\.7 Production/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/−6\.2 Risk safety/).length).toBeGreaterThan(0);
    // Zero-contribution preference stays honest instead of showing ±0 spin.
    expect(screen.getAllByText(/Preference ±0 — no personal adjustment/).length).toBeGreaterThan(0);
  });

  it("lists EVERY component with signed points and reasons in the collapsible table", async () => {
    render(<DraftRoom draftId="d-1" initial={{ ...initial, strategy: strategyFixture }} />);
    const summaries = await screen.findAllByText("All components");
    const summary = summaries[0];
    if (!summary) throw new Error("All components summary missing");
    await userEvent.click(summary);
    const tables = document.querySelectorAll(".dc-contrib-table");
    expect(tables.length).toBe(2); // one per rendered recommendation
    expect(tables[0]?.textContent).toContain("(no personal adjustment)");
    expect(tables[0]?.textContent).toContain("+8.7");
    expect(tables[0]?.textContent).toContain("−6.2");
    expect(tables[0]?.textContent).toContain("blended projected points percentile");
  });

  it("renders entry warnings next to the recommendation, announces them once, and never disables Draft", async () => {
    render(<DraftRoom draftId="d-1" initial={{ ...initial, strategy: strategyFixture }} />);
    expect(
      await screen.findByText(/Preference reach: market ADP 31 picks beyond your current pick\./),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(politeRegion()?.textContent).toContain("Warning:");
    });
    // The warned player's Draft button stays enabled (advisory only).
    const recItem = screen.getByText("Nikola Jokić").closest("li");
    const draftButton = recItem
      ? Array.from(recItem.querySelectorAll("button")).find((b) => b.textContent === "Draft")
      : undefined;
    if (!draftButton) throw new Error("Draft button missing for warned recommendation");
    expect(draftButton).toBeEnabled();

    // Make a pick: afterwards the region carries the pick confirmation, NOT a
    // second warning — warnings announced exactly once on first appearance.
    await userEvent.click(draftButton);
    await waitFor(() => {
      expect(recordedUrls.some((call) => call.includes("/picks"))).toBe(true);
    });
    await waitFor(() => {
      expect(politeRegion()?.textContent).toContain("drafted by");
    });
    expect(politeRegion()?.textContent).not.toContain("Warning:");
  });
});

// ---------------------------------------------------------------------------
// Phase 3C (additive): mock-draft surfaces. DraftRoom gains an OPTIONAL
// `initial.mock` slice during the primary integration patch; these describes
// pin the contract that must hold BOTH before and after wiring, plus the
// post-integration assertions ready to activate (see skipped case).
// ---------------------------------------------------------------------------

const mockPayload = {
  simSeed: "SEED-42",
  teams: [
    { slot: 1, displayName: "Team 1", isUserTeam: false, personalityKey: "playmaker" },
    { slot: 4, displayName: "Team 4", isUserTeam: true, personalityKey: null },
  ],
};

describe("DraftRoom mock surfaces (Phase 3C)", () => {
  it("omits every mock control when initial.mock is absent", () => {
    renderRoom();
    expect(screen.queryByRole("button", { name: /advance/i })).toBeNull();
    expect(screen.queryByRole("switch", { name: /auto-advance/i })).toBeNull();
    expect(screen.queryByText(/simulation seed/i)).toBeNull();
    expect(screen.queryByRole("group", { name: "Mock draft controls" })).toBeNull();
  });

  it("tolerates a mock payload on initial without disturbing REAL room surfaces", () => {
    const withMock = { ...initial, mock: mockPayload };
    render(<DraftRoom draftId="d-1" initial={withMock} />);
    expect(screen.getByRole("tabpanel", { name: "Top three recommendations" })).toBeInTheDocument();
    expect(screen.getByLabelText("Available players")).toBeInTheDocument();
    expect(screen.getByLabelText("My roster")).toBeInTheDocument();
  });

  // Activate together with the primary DraftRoom patch that wires
  // MockStatusStrip + MockDraftControls + useMockRunner from initial.mock:
  it.skip("renders the seed strip and control cluster when initial.mock is present", () => {
    const withMock = { ...initial, mock: mockPayload };
    render(<DraftRoom draftId="d-1" initial={withMock} />);
    expect(screen.getByText("SEED-42")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy simulation seed" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Mock draft controls" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Advance" })).toBeInTheDocument();
  });
});
