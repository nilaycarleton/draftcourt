import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesWorkspace } from "@/features/preferences/PreferencesWorkspace";

/**
 * Component tests for the /preferences workspace with a mocked fetch layer
 * (envelope shape identical to the real API). Covers the states the Impeccable
 * shape requires: loading, empty, populated, saving, error, unsaved-changes
 * guard, preset application, and rank editing.
 */

type RouteHandler = (path: string, init?: RequestInit) => unknown;
const routes = new Map<string, RouteHandler>();

function mockRoute(method: string, prefix: string, handler: RouteHandler): void {
  routes.set(`${method} ${prefix}`, handler);
}

beforeEach(() => {
  routes.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? String(input) : input.url;
      for (const [key, handler] of routes) {
        const [method = "", prefix = ""] = key.split(" ");
        if (init?.method === method && path.startsWith(prefix)) {
          const data = await handler(path, init);
          if (data instanceof Response) return data;
          return new Response(JSON.stringify({ data, error: null, meta: { traceId: "t" } }), {
            status: 200,
          });
        }
      }
      return new Response(
        JSON.stringify({ data: null, error: { detail: "not found", status: 404 }, meta: {} }),
        { status: 404 },
      );
    }),
  );
});

const emptyList = { profiles: [], nextCursor: null };

function baseProfile(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Profile ${id}`,
    presetKey: "balanced",
    presetVersion: 1,
    schemaVersion: 1,
    isDefault: false,
    updatedAt: new Date().toISOString(),
    settings: {
      schemaVersion: 1,
      factorWeights: Object.fromEntries(
        [
          "production",
          "scarcity",
          "rosterNeed",
          "risk",
          "consistency",
          "age",
          "adpValue",
          "upside",
          "role",
          "nextPickAvailability",
          "preference",
        ].map((key, index) => [key, 1 / (index + 1) / 3.0199]),
      ),
      lockedFactors: [],
      riskTolerance: 0.5,
      upsidePriority: 0.5,
      youthBias: 0,
      roleMinutesPriority: 0.5,
      schedule: { enabled: false, playoffWeeks: null },
      positionPriorities: [],
      categoryPriorities: [],
      puntStats: [],
      avoidMode: "EXCLUDE",
    },
    playerPreferences: [],
    teamPreferences: [],
    ...overrides,
  };
}

describe("PreferencesWorkspace", () => {
  it("renders an empty-state prompt and creates a profile via POST", async () => {
    let created = false;
    mockRoute("GET", "/api/v1/preference-profiles", () =>
      created ? { profiles: [baseProfile("p1")], nextCursor: null } : emptyList,
    );
    mockRoute("POST", "/api/v1/preference-profiles", () => {
      created = true;
      return baseProfile("p1");
    });
    render(<PreferencesWorkspace />);

    await screen.findByText(/No profile selected/);
    await userEvent.click(screen.getByRole("button", { name: "New profile" }));
    await userEvent.type(screen.getByLabelText("Profile name"), "My strategy");
    await userEvent.click(screen.getByRole("button", { name: "Save preferences" }));

    await waitFor(() => {
      expect(screen.getAllByText(/created/i).length).toBeGreaterThan(0);
    });
  });

  it("loads a populated profile, applies a preset, and shows dirty save bar", async () => {
    let patched = false;
    mockRoute("GET", "/api/v1/preference-profiles", (path) => {
      if (path === "/api/v1/preference-profiles") {
        return { profiles: [baseProfile("p1")], nextCursor: null };
      }
      return patched ? baseProfile("p1") : baseProfile("p1");
    });
    mockRoute("PATCH", "/api/v1/preference-profiles/", () => {
      patched = true;
      return baseProfile("p1");
    });
    render(<PreferencesWorkspace />);
    await screen.findByRole("button", { name: /Profile p1/ });

    await userEvent.click(screen.getByRole("button", { name: /Win Now/ }));
    expect(screen.getAllByText(/Win Now preset applied/i).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Save preferences" })[0]).toBeEnabled();
  });

  it("surfaces API errors in the alert banner", async () => {
    mockRoute("GET", "/api/v1/preference-profiles", () => emptyList);
    mockRoute(
      "POST",
      "/api/v1/preference-profiles",
      () =>
        new Response(
          JSON.stringify({
            data: null,
            error: { detail: 'a profile named "X" already exists', status: 409 },
            meta: {},
          }),
          { status: 409 },
        ),
    );
    render(<PreferencesWorkspace />);
    await screen.findByText(/No profile selected/);
    await userEvent.click(screen.getByRole("button", { name: "New profile" }));
    await userEvent.type(screen.getByLabelText("Profile name"), "X");
    await userEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/already exists/);
    });
  });

  it("shows the custom board and saves order via PUT", async () => {
    const putBodies: unknown[] = [];
    mockRoute("GET", "/api/v1/preference-profiles", (path) => {
      // eslint-disable-next-line no-console
      console.log("MOCK-GET", path);
      if (path !== "/api/v1/preference-profiles") {
        return baseProfile(path.split("/").pop() ?? "p1");
      }
      return { profiles: [baseProfile("p1")], nextCursor: null };
    });
    mockRoute("GET", "/api/v1/leagues", () => []);
    mockRoute("GET", "/api/v1/custom-ranks", () => ({
      leagueId: null,
      ranks: [
        { playerId: "pa", displayName: "Alpha", rank: 1, tier: null, note: null },
        { playerId: "pb", displayName: "Beta", rank: 2, tier: null, note: null },
      ],
    }));
    mockRoute("PUT", "/api/v1/custom-ranks", (_path, init) => {
      const rawBody = init?.body;
      putBodies.push(typeof rawBody === "string" ? JSON.parse(rawBody) : {});
      return { count: 2 };
    });
    render(<PreferencesWorkspace />);

    await screen.findByText("Custom big board");
    const upBeta = screen.getByRole("button", { name: "Move Beta up to position 1" });
    await userEvent.click(upBeta);
    await userEvent.click(screen.getByRole("button", { name: "Save board order" }));

    await waitFor(() => {
      expect(putBodies.length).toBe(1);
    });
    const body = putBodies[0] as { ranks: { playerId: string; rank: number }[] };
    expect(body.ranks.map((rank) => rank.playerId)).toEqual(["pb", "pa"]);
    expect(body.ranks.map((rank) => rank.rank)).toEqual([1, 2]);
  });
});
