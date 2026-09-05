import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrategyProfilePicker } from "@/features/leagues/StrategyProfilePicker";

/**
 * StrategyProfilePicker unit coverage (Phase 3B): option rendering in both
 * default/no-default states, PATCH body correctness, error banner keeping the
 * selection for retry, and long-name title truncation.
 */

const profiles = [
  {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    name: "Balanced Base",
    presetKey: "balanced",
    presetVersion: 1,
    isDefault: true,
  },
  {
    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    name: "An Extremely Long Profile Name That Should Truncate With An Ellipsis In The Row",
    presetKey: null,
    presetVersion: null,
    isDefault: false,
  },
];

function mockFetch(handler: (url: string, init?: RequestInit) => Response | undefined): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const handled = handler(url, init);
      if (handled) return Promise.resolve(handled);
      return Promise.resolve(
        new Response(JSON.stringify({ data: null, error: { detail: "unmocked" } }), {
          status: 404,
        }),
      );
    }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("StrategyProfilePicker", () => {
  it("renders the fall-through option and one row per profile with preset labels and default marker", () => {
    render(
      <StrategyProfilePicker
        leagueId="league-1"
        profiles={profiles}
        selection={{
          preferredProfileId: null,
          preferredProfileName: null,
          defaultProfileId: profiles[0]?.id ?? null,
          defaultProfileName: "Balanced Base",
        }}
      />,
    );
    expect(
      screen.getByRole("radio", { name: /Use my default profile at draft time/ }),
    ).toBeChecked();
    // Default-name hint renders under the fall-through row.
    const fallthroughRow = screen
      .getByRole("radio", { name: /Use my default profile/ })
      .closest("label");
    expect(fallthroughRow?.querySelector(".dc-strategy-meta")?.textContent).toBe("Balanced Base");
    expect(
      screen.getByRole("radiogroup", { name: "Preferred strategy profile" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /An Extremely Long Profile Name/ })).not.toBeChecked();
    // Preset labels: known key → title, unknown/null → Custom; ★ marks default.
    const rows = screen.getAllByRole("radio").map((radio) => radio.closest("label"));
    const presetTexts = rows.map((row) => row?.querySelector(".dc-strategy-meta")?.textContent);
    expect(presetTexts).toContain("Custom");
    expect(screen.getByText("★")).toBeInTheDocument();
  });

  it('shows "No default set" when no default profile exists', () => {
    render(
      <StrategyProfilePicker
        leagueId="league-1"
        profiles={[]}
        selection={{
          preferredProfileId: null,
          preferredProfileName: null,
          defaultProfileId: null,
          defaultProfileName: null,
        }}
      />,
    );
    expect(screen.getByText("No default set")).toBeInTheDocument();
  });

  it("saves a profile choice via PATCH with the correct body and announces success", async () => {
    const patchBodies: unknown[] = [];
    mockFetch((url, init) => {
      if (init?.method === "PATCH" && url === "/api/v1/leagues/league-1") {
        patchBodies.push(JSON.parse(typeof init.body === "string" ? init.body : "{}"));
        return new Response(JSON.stringify({ data: { id: "league-1" }, error: null }), {
          status: 200,
        });
      }
      return undefined;
    });
    render(
      <StrategyProfilePicker
        leagueId="league-1"
        profiles={profiles}
        selection={{
          preferredProfileId: null,
          preferredProfileName: null,
          defaultProfileId: profiles[0]?.id ?? null,
          defaultProfileName: "Balanced Base",
        }}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: /^Balanced Base/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save strategy" }));
    await waitFor(() => {
      expect(patchBodies).toHaveLength(1);
    });
    expect(patchBodies[0]).toEqual({
      preferredProfileId: profiles[0]?.id,
    });
    await waitFor(() => {
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain(
        "Strategy saved",
      );
    });
    expect(screen.getAllByText(/Strategy saved/).length).toBeGreaterThan(0);
  });

  it("clears the selection to null when the fall-through option is saved", async () => {
    const patchBodies: unknown[] = [];
    mockFetch((_url, init) => {
      if (init?.method === "PATCH") {
        patchBodies.push(JSON.parse(typeof init.body === "string" ? init.body : "{}"));
        return new Response(JSON.stringify({ data: {}, error: null }), { status: 200 });
      }
      return undefined;
    });
    render(
      <StrategyProfilePicker
        leagueId="league-1"
        profiles={profiles}
        selection={{
          preferredProfileId: profiles[0]?.id ?? null,
          preferredProfileName: "Balanced Base",
          defaultProfileId: null,
          defaultProfileName: null,
        }}
      />,
    );
    await userEvent.click(
      screen.getByRole("radio", { name: /Use my default profile at draft time/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save strategy" }));
    await waitFor(() => {
      expect(patchBodies).toHaveLength(1);
    });
    expect(patchBodies[0]).toEqual({ preferredProfileId: null });
  });

  it("surfaces failure detail in an alert banner while keeping the selection for retry", async () => {
    mockFetch((_url, init) => {
      if (init?.method === "PATCH") {
        return new Response(
          JSON.stringify({
            data: null,
            error: { detail: "profile not found", status: 404 },
          }),
          { status: 404 },
        );
      }
      return undefined;
    });
    render(
      <StrategyProfilePicker
        leagueId="league-1"
        profiles={profiles}
        selection={{
          preferredProfileId: null,
          preferredProfileName: null,
          defaultProfileId: null,
          defaultProfileName: null,
        }}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: /^Balanced Base/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save strategy" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("profile not found");
    expect(alert.textContent).toContain("Retry");
    // Selection kept — the radio is still checked after the failed save.
    expect(screen.getByRole("radio", { name: /^Balanced Base/ })).toBeChecked();
  });

  it("exposes the full long name via title for truncated rows", () => {
    render(
      <StrategyProfilePicker
        leagueId="league-1"
        profiles={profiles}
        selection={{
          preferredProfileId: null,
          preferredProfileName: null,
          defaultProfileId: null,
          defaultProfileName: null,
        }}
      />,
    );
    const longRow = screen
      .getByRole("radio", { name: /An Extremely Long Profile Name/ })
      .closest("label");
    const nameSpan = longRow?.querySelector(".dc-strategy-option-name");
    expect(nameSpan?.getAttribute("title")).toBe(profiles[1]?.name);
    expect(nameSpan?.className).toContain("dc-strategy-option-name");
  });

  it("states that saving only affects future drafts", () => {
    render(
      <StrategyProfilePicker
        leagueId="league-1"
        profiles={[]}
        selection={{
          preferredProfileId: null,
          preferredProfileName: null,
          defaultProfileId: null,
          defaultProfileName: null,
        }}
      />,
    );
    expect(
      screen.getByText(
        /Applies to drafts started after you save\. Active drafts keep their locked strategy\./,
      ),
    ).toBeInTheDocument();
  });
});
