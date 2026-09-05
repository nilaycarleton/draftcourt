import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockDraftControls } from "@/features/drafts/MockDraftControls";
import { MOCK_SPEED_MS, type MockPacingSpeed } from "@/features/drafts/mockPacing";
import {
  useMockRunner,
  type MockCpuPickResult,
  type MockRunnerController,
  type MockRunnerDraft,
} from "@/features/drafts/useMockRunner";

/**
 * Phase 3C unit coverage: the presentational control cluster contract plus
 * fake-timer driving of useMockRunner through a wired harness — OFF ⇒ no
 * scheduling after a user pick; ON ⇒ stops exactly at the derived user turn;
 * cancel bumps the generation and ignores in-flight results; 409 ⇒ conflict +
 * resync; INSTANT bursts produce exactly ONE polite announcement; and a
 * second advance is refused while a POST is outstanding (single flight).
 */

/* ----- Presentational suite ------------------------------------------------ */

describe("MockDraftControls", () => {
  const baseProps = {
    phase: "idle" as const,
    progressText: "Mock controls ready.",
    advancing: false,
    canAdvance: true,
    speed: "NORMAL" as MockPacingSpeed,
    autoAdvance: false,
    onSpeedChange: vi.fn(),
    onAutoAdvanceChange: vi.fn(),
    onAdvance: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onCancel: vi.fn(),
  };

  it("renders the labelled group, Speed radiogroup and off switch by default", () => {
    render(<MockDraftControls {...baseProps} />);
    expect(screen.getByRole("group", { name: "Mock draft controls" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Speed" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Slow" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Normal" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Instant" })).not.toBeChecked();
    const toggle = screen.getByRole("switch", { name: "Auto-advance" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("reports speed changes and reflects the auto-advance switch state", async () => {
    const onSpeedChange = vi.fn();
    const onAutoAdvanceChange = vi.fn();
    render(
      <MockDraftControls
        {...baseProps}
        speed="INSTANT"
        autoAdvance
        onSpeedChange={onSpeedChange}
        onAutoAdvanceChange={onAutoAdvanceChange}
      />,
    );
    expect(screen.getByRole("radio", { name: "Instant" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Auto-advance" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userClick(screen.getByRole("radio", { name: "Slow" }));
    expect(onSpeedChange).toHaveBeenCalledWith("SLOW");
    await userClick(screen.getByRole("switch", { name: "Auto-advance" }));
    expect(onAutoAdvanceChange).toHaveBeenCalledWith(false);
  });

  it("keeps the progress line out of live regions and swaps Advance for Cancel while advancing", async () => {
    const onAdvance = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(<MockDraftControls {...baseProps} onAdvance={onAdvance} />);
    const progress = screen.getByText("Mock controls ready.");
    expect(progress).toHaveAttribute("aria-live", "off");
    await userClick(screen.getByRole("button", { name: "Advance" }));
    expect(onAdvance).toHaveBeenCalledOnce();

    rerender(<MockDraftControls {...baseProps} advancing canAdvance={false} onCancel={onCancel} />);
    expect(screen.queryByRole("button", { name: "Advance" })).toBeNull();
    await userClick(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows Pause only while advancing and Resume only while paused", async () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const { rerender } = render(
      <MockDraftControls {...baseProps} phase="cpuAdvancing" advancing onPause={onPause} />,
    );
    await userClick(screen.getByRole("button", { name: "Pause" }));
    expect(onPause).toHaveBeenCalledOnce();

    rerender(<MockDraftControls {...baseProps} phase="paused" onResume={onResume} />);
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    await userClick(screen.getByRole("button", { name: "Resume" }));
    expect(onResume).toHaveBeenCalledOnce();
  });
});

async function userClick(element: HTMLElement): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    fireEvent.click(element);
  });
}

/* ----- Runner harness ------------------------------------------------------- */

const TEAMS: MockRunnerDraft["teams"] = [
  { slot: 1, displayName: "Team 1", isUserTeam: false },
  { slot: 2, displayName: "Team 2", isUserTeam: false },
  { slot: 3, displayName: "Team 3", isUserTeam: false },
  { slot: 4, displayName: "Me", isUserTeam: true },
];

function draftAt(
  nextOverallPick: number,
  status = "ACTIVE",
  version = nextOverallPick,
): MockRunnerDraft {
  return { version, status, nextOverallPick, currentSequence: nextOverallPick - 1, teams: TEAMS };
}

/** Snake-slot ownership derived ONLY from fresh data (injected helper). */
function isUserSlotFour(draft: MockRunnerDraft): boolean {
  const teamCount = draft.teams.length;
  const positionInRound = ((draft.nextOverallPick - 1) % teamCount) + 1;
  const round = Math.ceil(draft.nextOverallPick / teamCount);
  const slot = round % 2 === 1 ? positionInRound : teamCount + 1 - positionInRound;
  return slot === 4;
}

function cpuPickBody(nextOverallPick: number, status = "ACTIVE"): string {
  const result: MockCpuPickResult = {
    pick: {
      playerId: `p-${String(nextOverallPick - 1)}`,
      displayName: `CPU Star ${String(nextOverallPick - 1)}`,
      slotPosition: "UTIL",
      isBench: false,
      sequence: nextOverallPick - 1,
    },
    evidence: {
      personalityKey: "playmaker",
      personalityVersion: "1",
      decisionChecksum: "checksum-1",
      selectionScore: 90.5,
      decisionSeed: "seed-1",
    },
    authoritative: {
      version: nextOverallPick,
      status,
      currentSequence: nextOverallPick - 1,
      nextOverallPick,
    },
  };
  return JSON.stringify({ data: result, error: null });
}

interface PostRecord {
  url: string;
  headers: Record<string, string>;
}

interface Harness {
  controller: MockRunnerController;
  posts: PostRecord[];
  getDraftCalls: number;
  drafts: MockRunnerDraft[];
  /** Arms the NEXT cpu-pick POST to hang until releasePendingPost(). */
  hangNextPost: (response: Response) => void;
  /** Releases a previously hung POST with its armed response. */
  releasePendingPost: () => void;
  announce: ReturnType<typeof vi.fn>;
  onPickCommitted: ReturnType<typeof vi.fn>;
}

/**
 * Renders MockDraftControls wired to useMockRunner against stubbed fetch.
 * `drafts` are served per GET (the last repeats); each POST consumes the next
 * queued factory (the last repeats), or hangs when armed via hangNextPost.
 */
function renderHarness(options: {
  drafts: MockRunnerDraft[];
  postFactories?: (() => Response)[];
  speedMs?: number;
}): Harness {
  const posts: PostRecord[] = [];
  const announce = vi.fn();
  const onPickCommitted = vi.fn();
  let getDraftCalls = 0;
  let getIndex = 0;
  let postIndex = 0;
  const factories = options.postFactories ?? [() => new Response(cpuPickBody(99), { status: 200 })];
  let armedResponse: Response | null = null;
  let armedResolve: ((response: Response) => void) | null = null;

  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as unknown as Record<string, string>;
      if (url.endsWith("/cpu-pick")) {
        posts.push({ url, headers });
        if (armedResponse !== null) {
          const response = armedResponse;
          armedResponse = null;
          return new Promise<Response>((resolve) => {
            armedResolve = resolve;
          }).then(() => response);
        }
        const fallback = (): Response => new Response(cpuPickBody(99), { status: 200 });
        const factory = factories[Math.min(postIndex, factories.length - 1)] ?? fallback;
        postIndex += 1;
        return Promise.resolve(factory());
      }
      getDraftCalls += 1;
      const draft = options.drafts[Math.min(getIndex, options.drafts.length - 1)];
      getIndex += 1;
      return Promise.resolve(new Response(JSON.stringify({ data: draft }), { status: 200 }));
    }),
  );

  let controllerRef: MockRunnerController | null = null;
  function Harness(): React.JSX.Element {
    const runner = useMockRunner("d-mock", {
      getDraft: async () => {
        const response = await fetch("/api/v1/drafts/d-mock");
        const body = (await response.json()) as { data: MockRunnerDraft };
        return body.data;
      },
      isUserTurn: isUserSlotFour,
      announce,
      onPickCommitted,
      ...(options.speedMs !== undefined ? { speedMs: options.speedMs } : {}),
    });
    controllerRef = runner;
    return (
      <MockDraftControls
        phase={runner.phase}
        progressText={runner.progressText}
        advancing={runner.advancing}
        canAdvance={runner.canAdvance}
        speed="NORMAL"
        autoAdvance={false}
        onSpeedChange={() => undefined}
        onAutoAdvanceChange={() => undefined}
        onAdvance={() => {
          void runner.advanceOnce();
        }}
        onPause={runner.pause}
        onResume={() => {
          void runner.resume();
        }}
        onCancel={runner.cancel}
      />
    );
  }

  render(<Harness />);

  return {
    get controller(): MockRunnerController {
      if (controllerRef === null) throw new Error("harness not mounted");
      return controllerRef;
    },
    posts,
    get getDraftCalls(): number {
      return getDraftCalls;
    },
    drafts: options.drafts,
    hangNextPost(response: Response): void {
      armedResponse = response;
    },
    releasePendingPost(): void {
      const resolve = armedResolve;
      armedResolve = null;
      if (resolve !== null) {
        // Any 200 works here — the generation was already bumped by cancel,
        // so the payload must be dropped regardless of its content.
        resolve(new Response(cpuPickBody(2), { status: 200 }));
      }
    },
    announce,
    onPickCommitted,
  };
}

describe("useMockRunner (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("auto OFF ⇒ a user pick schedules nothing further", async () => {
    const harness = renderHarness({
      drafts: [draftAt(2)],
      postFactories: [() => new Response(cpuPickBody(2), { status: 200 })],
    });
    await act(async () => {
      await harness.controller.advanceOnce();
    });
    expect(harness.posts).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(harness.posts).toHaveLength(1);
    expect(harness.onPickCommitted).toHaveBeenCalledTimes(1);
  });

  it("auto ON ⇒ advances paced picks and stops EXACTLY at the derived user turn", async () => {
    const harness = renderHarness({
      drafts: [draftAt(2), draftAt(3), draftAt(4)],
      speedMs: 500,
    });
    act(() => {
      void harness.controller.startAutoAdvance();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MOCK_SPEED_MS.NORMAL);
    });
    expect(harness.posts).toHaveLength(2);
    expect(harness.controller.phase).toBe("idle");
    expect(harness.controller.progressText).toContain("Your turn");
    expect(harness.announce).toHaveBeenCalledTimes(1);
    expect(String(harness.announce.mock.calls[0]?.[0])).toContain("overall pick 4");
    // Settled: time passing produces nothing further.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(harness.posts).toHaveLength(2);
  });

  it("cancel bumps the generation and drops the in-flight result", async () => {
    const harness = renderHarness({ drafts: [draftAt(2)], speedMs: MOCK_SPEED_MS.INSTANT });
    harness.hangNextPost(new Response(cpuPickBody(2), { status: 200 }));
    act(() => {
      void harness.controller.startAutoAdvance();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MOCK_SPEED_MS.INSTANT);
    });
    expect(harness.posts).toHaveLength(1);

    await userClick(screen.getByRole("button", { name: "Cancel" }));
    expect(harness.controller.phase).toBe("idle");
    harness.releasePendingPost();

    await act(async () => {
      await Promise.resolve();
    });
    expect(harness.onPickCommitted).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(harness.posts).toHaveLength(1);
    expect(harness.announce).toHaveBeenCalledExactlyOnceWith("Auto-advance cancelled.");
  });

  it("a 409 conflict resyncs authority and settles into an error phase", async () => {
    const harness = renderHarness({
      drafts: [draftAt(2)],
      postFactories: [
        () =>
          new Response(
            JSON.stringify({ type: "/problems/version-conflict", detail: "If-Match stale" }),
            { status: 409 },
          ),
      ],
      speedMs: 1000,
    });
    act(() => {
      void harness.controller.startAutoAdvance();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(harness.getDraftCalls).toBeGreaterThanOrEqual(2); // evaluate + resync
    expect(harness.controller.phase).toBe("error");
    expect(harness.announce).toHaveBeenCalledTimes(1);
    expect(String(harness.announce.mock.calls[0]?.[0])).toContain("re-synced");
    expect(harness.posts).toHaveLength(1);
  });

  it("an INSTANT burst makes exactly ONE polite-region announcement", async () => {
    const harness = renderHarness({
      drafts: [draftAt(2), draftAt(3), draftAt(4)],
      speedMs: MOCK_SPEED_MS.INSTANT,
    });
    act(() => {
      void harness.controller.startAutoAdvance();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MOCK_SPEED_MS.NORMAL);
    });
    expect(harness.posts).toHaveLength(2);
    expect(harness.announce).toHaveBeenCalledTimes(1);
    expect(harness.controller.phase).toBe("idle");
  });

  it("refuses a second POST while one is outstanding (single flight)", async () => {
    const harness = renderHarness({
      drafts: [draftAt(2)],
      postFactories: [() => new Response(cpuPickBody(2), { status: 200 })],
    });
    harness.hangNextPost(new Response(cpuPickBody(2), { status: 200 }));

    let firstSettled = false;
    const first = harness.controller.advanceOnce().then(() => {
      firstSettled = true;
    });
    await act(async () => {
      await harness.controller.advanceOnce();
    });
    expect(harness.posts).toHaveLength(1);

    harness.releasePendingPost();
    await act(async () => {
      await first;
    });
    expect(firstSettled).toBe(true);
    expect(harness.posts).toHaveLength(1);
    expect(harness.onPickCommitted).toHaveBeenCalledTimes(1);
  });

  it("pauses mid-run, stalls indefinitely, then resumes to completion of the burst", async () => {
    const harness = renderHarness({
      drafts: [draftAt(2), draftAt(3), draftAt(6), draftAt(4)],
      speedMs: 1000,
    });
    act(() => {
      void harness.controller.startAutoAdvance();
    });
    // First CPU pick fires immediately; the loop is now pacing before #2.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(harness.posts).toHaveLength(1);

    await userClick(screen.getByRole("button", { name: "Pause" }));
    expect(harness.controller.phase).toBe("paused");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(harness.posts).toHaveLength(1); // fully stalled

    await userClick(screen.getByRole("button", { name: "Resume" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // Resume picks up where the burst left off: overalls 3 and 6 are CPU
    // turns (paced), then the derived user turn settles it.
    expect(harness.posts).toHaveLength(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(harness.controller.phase).toBe("idle"); // settled at user turn
    expect(harness.announce).toHaveBeenCalledTimes(1);
  });
});
