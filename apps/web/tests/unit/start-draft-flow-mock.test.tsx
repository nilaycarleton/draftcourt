import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRouter } from "next/navigation";
import { StartDraftFlow, type StartDraftLeague } from "@/features/drafts/StartDraftFlow";
import { DEFAULT_MOCK_PACING, readMockPacing } from "@/features/drafts/mockPacing";

/**
 * Phase 3C unit coverage for the MOCK branch of /drafts/new: section reveal,
 * create-body composition (type + cpuPersonalityKey + simulationSeed only
 * when entered + teamPersonalities ONLY for overridden teams), seed inline
 * validation, pacing persistence, and byte-stable REAL bodies.
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
    userDraftSlot: 1,
    teamCount: 4,
    strategySelection: {
      preferredProfileId: null,
      preferredProfileName: null,
      defaultProfileId: "pp-1",
      defaultProfileName: "Balanced Base",
    },
  },
];

const personalities = [
  { key: "playmaker", title: "Playmaker", description: "Chases assist leaders." },
  { key: "risk-taker", title: "Risk Taker", description: "Reaches for upside." },
];

const teams = [
  { slot: 1, displayName: "Me", isUserTeam: true },
  { slot: 2, displayName: "CPU North", isUserTeam: false },
  { slot: 3, displayName: "CPU South", isUserTeam: false },
  { slot: 4, displayName: "CPU East", isUserTeam: false },
];

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

function baseFetch(calls: Call[]): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    if (url.startsWith("/api/v1/leagues/") && url.includes("/strategy-preview")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              kind: "LEAGUE_SELECTION",
              profileId: "pp-1",
              profileName: "Balanced Base",
              settingsSummary: {
                topFactors: [{ key: "production", weight: 0.4 }],
                punts: [],
                avoidMode: "EXCLUDE",
                scheduleEnabled: false,
              },
            },
            error: null,
          }),
          { status: 200 },
        ),
      );
    }
    if (url === "/api/v1/drafts" && method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify({ data: { id: "draft-mock-1" } }), { status: 200 }),
      );
    }
    if (url === "/api/v1/drafts/draft-mock-1/start") {
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
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(baseFetch(calls)));
  const router = useRouter() as unknown as { push: ReturnType<typeof vi.fn> };
  router.push.mockReset();
});

async function selectMockType(): Promise<void> {
  await userEvent.click(screen.getByRole("radio", { name: /Winter Classic/ }));
  await userEvent.click(screen.getByRole("radio", { name: /Mock draft/ }));
}

describe("StartDraftFlow mock branch", () => {
  it("reveals personality picker, advanced overrides, seed and pacing only for MOCK", async () => {
    render(<StartDraftFlow leagues={leagues} personalities={personalities} teams={teams} />);
    expect(screen.queryByRole("region", { name: "Mock draft setup" })).toBeNull();
    expect(screen.queryByLabelText("Simulation seed (optional)")).toBeNull();

    await selectMockType();

    expect(screen.getByRole("region", { name: "Mock draft setup" })).toBeInTheDocument();
    // Default selection is the FIRST catalog option.
    expect(screen.getByRole("radio", { name: /Playmaker/ })).toBeChecked();
    expect(screen.getByText("Chases assist leaders.")).toBeInTheDocument();
    expect(screen.getByLabelText("Simulation seed (optional)")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Auto-advance" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByText("Advanced: per-team personalities")).toBeInTheDocument();
  });

  it("keeps REAL as the default type and sends a body identical to the pre-3C flow", async () => {
    render(<StartDraftFlow leagues={leagues} personalities={personalities} teams={teams} />);
    expect(screen.getByRole("radio", { name: /Real draft/ })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: /Winter Classic/ }));
    await userEvent.click(screen.getByRole("button", { name: "Start draft" }));
    await waitFor(() => {
      const router = useRouter() as unknown as { push: ReturnType<typeof vi.fn> };
      expect(router.push).toHaveBeenCalledWith("/drafts/draft-mock-1");
    });
    const createCall = calls.find(
      (call) => call.method === "POST" && call.url === "/api/v1/drafts",
    );
    expect(createCall?.body).toEqual({ leagueId: leagues[0]?.id });
  });

  it("sends type/cpuPersonalityKey/simulationSeed and ONLY overridden teamPersonalities", async () => {
    render(<StartDraftFlow leagues={leagues} personalities={personalities} teams={teams} />);
    await selectMockType();

    // Advanced: override exactly ONE non-user team.
    await userEvent.click(screen.getByText("Advanced: per-team personalities"));
    await userEvent.selectOptions(screen.getByLabelText("CPU North"), "risk-taker");

    await userEvent.type(screen.getByLabelText("Simulation seed (optional)"), "SEED-42");
    await userEvent.click(screen.getByRole("button", { name: "Start draft" }));

    await waitFor(() => {
      const router = useRouter() as unknown as { push: ReturnType<typeof vi.fn> };
      expect(router.push).toHaveBeenCalledWith("/drafts/draft-mock-1");
    });
    const createCall = calls.find(
      (call) => call.method === "POST" && call.url === "/api/v1/drafts",
    );
    expect(createCall?.body).toEqual({
      leagueId: leagues[0]?.id,
      type: "MOCK",
      cpuPersonalityKey: "playmaker",
      teamPersonalities: [{ teamSlot: 2, personalityKey: "risk-taker" }],
      simulationSeed: "SEED-42",
    });
  });

  it("omits cpuPersonalityKey when Follow default is chosen and omits an empty seed", async () => {
    render(<StartDraftFlow leagues={leagues} personalities={personalities} teams={teams} />);
    await selectMockType();
    await userEvent.click(screen.getByRole("radio", { name: /Follow default/ }));
    await userEvent.click(screen.getByRole("button", { name: "Start draft" }));
    await waitFor(() => {
      const router = useRouter() as unknown as { push: ReturnType<typeof vi.fn> };
      expect(router.push).toHaveBeenCalledWith("/drafts/draft-mock-1");
    });
    const createCall = calls.find(
      (call) => call.method === "POST" && call.url === "/api/v1/drafts",
    );
    expect(createCall?.body).toEqual({ leagueId: leagues[0]?.id, type: "MOCK" });
  });

  it("blocks submit with an inline error for an invalid seed and never posts", async () => {
    render(<StartDraftFlow leagues={leagues} personalities={personalities} teams={teams} />);
    await selectMockType();
    await userEvent.type(screen.getByLabelText("Simulation seed (optional)"), "bad seed!");
    await userEvent.click(screen.getByRole("button", { name: "Start draft" }));
    expect(await screen.findByText(/letters, numbers and dashes/)).toBeInTheDocument();
    expect(screen.getByLabelText("Simulation seed (optional)")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(calls.some((call) => call.method === "POST" && call.url === "/api/v1/drafts")).toBe(
      false,
    );

    // Fixing the input clears the error and allows the same click path.
    const seedInput = screen.getByLabelText("Simulation seed (optional)");
    await userEvent.clear(seedInput);
    await userEvent.type(seedInput, "fixed-seed");
    expect(screen.queryByText(/letters, numbers and dashes/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Start draft" }));
    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url === "/api/v1/drafts")).toBe(
        true,
      );
    });
    const createCall = calls.find(
      (call) => call.method === "POST" && call.url === "/api/v1/drafts",
    );
    expect(createCall?.body).toMatchObject({ simulationSeed: "fixed-seed" });
  });

  it("degrades gracefully before wiring: empty catalog and team list still start a MOCK", async () => {
    render(<StartDraftFlow leagues={leagues} />);
    await selectMockType();
    expect(screen.getByText(/CPU personalities are unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/Team list unavailable/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start draft" }));
    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url === "/api/v1/drafts")).toBe(
        true,
      );
    });
    const createCall = calls.find(
      (call) => call.method === "POST" && call.url === "/api/v1/drafts",
    );
    expect(createCall?.body).toEqual({ leagueId: leagues[0]?.id, type: "MOCK" });
  });

  it("persists pacing speed and auto-advance through mockPacing helpers", async () => {
    render(<StartDraftFlow leagues={leagues} personalities={personalities} teams={teams} />);
    await selectMockType();
    await userEvent.click(screen.getByRole("radio", { name: "Instant" }));
    expect(readMockPacing().speed).toBe("INSTANT");
    await userEvent.click(screen.getByRole("switch", { name: "Auto-advance" }));
    expect(readMockPacing()).toEqual({ speed: "INSTANT", autoAdvance: true });
    expect(readMockPacing()).not.toEqual(DEFAULT_MOCK_PACING);
  });
});
