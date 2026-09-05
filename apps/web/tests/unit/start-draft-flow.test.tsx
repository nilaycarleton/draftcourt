import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRouter } from "next/navigation";
import { StartDraftFlow, type StartDraftLeague } from "@/features/drafts/StartDraftFlow";

/**
 * StartDraftFlow unit coverage (Phase 3B): preview refetch on league change,
 * override flowing into BOTH the preview query and the create body, the
 * create → start → navigate sequence, and failures keeping every choice.
 */

vi.mock("next/navigation", () => {
  const push = vi.fn();
  const refresh = vi.fn();
  return { useRouter: (): { push: typeof push; refresh: typeof refresh } => ({ push, refresh }) };
});

const leagues: StartDraftLeague[] = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Winter Classic",
    type: "POINTS",
    userDraftSlot: 4,
    teamCount: 12,
    strategySelection: {
      preferredProfileId: null,
      preferredProfileName: null,
      defaultProfileId: "pp-1",
      defaultProfileName: "Balanced Base",
    },
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    name: "Roto League",
    type: "CATEGORIES",
    userDraftSlot: 1,
    teamCount: 10,
    strategySelection: {
      preferredProfileId: "pp-2",
      preferredProfileName: "Win Now",
      defaultProfileId: null,
      defaultProfileName: null,
    },
  },
];

const profileList = {
  profiles: [
    { id: "pp-1", name: "Balanced Base", isDefault: true },
    { id: "pp-3", name: "Custom Override", isDefault: false },
  ],
};

const previewBody = {
  kind: "LEAGUE_SELECTION" as const,
  profileId: "pp-2",
  profileName: "Win Now",
  presetKey: "win-now",
  presetVersion: 1,
  checksum: "cafe01",
  settingsSummary: {
    topFactors: [
      { key: "production", weight: 0.4 },
      { key: "risk", weight: 0.2 },
    ],
    punts: ["TOV"],
    avoidMode: "EXCLUDE" as const,
    scheduleEnabled: false,
    favoritePlayers: 1,
    dislikedPlayers: 0,
    targetPlayers: 2,
    avoidedPlayers: 0,
    teamPreferences: 0,
    customRanks: 0,
  },
};

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

function makeFetch(calls: Call[]): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    if (url.startsWith("/api/v1/leagues/") && url.includes("/strategy-preview")) {
      const overridden = url.includes("overrideProfileId=pp-3");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              ...previewBody,
              kind: overridden ? "DRAFT_OVERRIDE" : "LEAGUE_SELECTION",
              profileName: overridden ? "Custom Override" : "Win Now",
            },
            error: null,
          }),
          { status: 200 },
        ),
      );
    }
    if (url === "/api/v1/preference-profiles") {
      return Promise.resolve(new Response(JSON.stringify({ data: profileList }), { status: 200 }));
    }
    if (url === "/api/v1/drafts" && method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify({ data: { id: "draft-77" } }), { status: 200 }),
      );
    }
    if (url === "/api/v1/drafts/draft-77/start") {
      return Promise.resolve(
        new Response(JSON.stringify({ data: { status: "ACTIVE", version: 1 } }), { status: 200 }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ data: null, error: { detail: "unmocked", status: 404 } }), {
        status: 404,
      }),
    );
  };
}

const calls: Call[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(makeFetch(calls)));
  const router = useRouter() as unknown as { push: ReturnType<typeof vi.fn> };
  router.push.mockReset();
});

describe("StartDraftFlow", () => {
  it("refetches the strategy preview when the selected league changes", async () => {
    render(<StartDraftFlow leagues={leagues} />);
    expect(screen.getByText(/Choose a league to preview/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /Winter Classic/ }));
    await waitFor(() => {
      expect(
        calls.some((call) =>
          call.url.includes("11111111-1111-1111-1111-111111111111/strategy-preview"),
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/League selection “Win Now”:/)).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("radio", { name: /Roto League/ }));
    await waitFor(() => {
      expect(
        calls.filter((call) => call.url.includes("/strategy-preview")).length,
      ).toBeGreaterThanOrEqual(2);
    });
    expect(
      calls.some((call) =>
        call.url.includes("22222222-2222-2222-2222-222222222222/strategy-preview"),
      ),
    ).toBe(true);
  });

  it("sends the override id in the preview query AND the create body", async () => {
    render(<StartDraftFlow leagues={leagues} />);
    await userEvent.click(screen.getByRole("radio", { name: /Winter Classic/ }));
    await userEvent.click(screen.getByRole("radio", { name: /Pick a different profile/ }));
    // Profile list fetched once when override opens.
    await waitFor(() => {
      expect(calls.some((call) => call.url === "/api/v1/preference-profiles")).toBe(true);
    });
    await userEvent.selectOptions(screen.getByLabelText("Override profile"), "pp-3");
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("overrideProfileId=pp-3"))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/Draft override “Custom Override”:/)).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: "Start draft" }));
    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url === "/api/v1/drafts")).toBe(
        true,
      );
    });
    const createCall = calls.find(
      (call) => call.method === "POST" && call.url === "/api/v1/drafts",
    );
    expect(createCall?.body).toMatchObject({
      leagueId: leagues[0]?.id,
      overrideProfileId: "pp-3",
    });
  });

  it("posts create then start and navigates to the new draft room", async () => {
    render(<StartDraftFlow leagues={leagues} />);
    await userEvent.click(screen.getByRole("radio", { name: /Winter Classic/ }));
    await waitFor(() => {
      expect(screen.getByText(/League selection/)).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: "Start draft" }));
    await waitFor(() => {
      const router = useRouter() as unknown as { push: ReturnType<typeof vi.fn> };
      expect(router.push).toHaveBeenCalledWith("/drafts/draft-77");
    });
    const createIndex = calls.findIndex(
      (call) => call.method === "POST" && call.url === "/api/v1/drafts",
    );
    const startIndex = calls.findIndex((call) => call.url.endsWith("/drafts/draft-77/start"));
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(createIndex);
    // No override when following league selection.
    const createCall = calls[createIndex];
    expect(createCall?.body).not.toHaveProperty("overrideProfileId");
  });

  it("keeps every choice and offers retry when start fails", async () => {
    const failingFetch = (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === "/api/v1/drafts" && (init?.method ?? "GET") === "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: null,
              error: {
                type: "/problems/invalid-strategy",
                detail: "strategy could not be resolved",
                status: 422,
              },
            }),
            { status: 422 },
          ),
        );
      }
      return makeFetch(calls)(input, init);
    };
    vi.stubGlobal("fetch", vi.fn(failingFetch));
    render(<StartDraftFlow leagues={leagues} />);
    await userEvent.click(screen.getByRole("radio", { name: /Winter Classic/ }));
    await waitFor(() => {
      expect(screen.getByText(/League selection/)).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: "Start draft" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("strategy could not be resolved");
    // Choices preserved: league still selected, override mode untouched.
    expect(screen.getByRole("radio", { name: /Winter Classic/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Follow league selection/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
