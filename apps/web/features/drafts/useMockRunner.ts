"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Mock-draft CPU runner (Phase 3C). Drives POST /api/v1/drafts/:id/cpu-pick
 * against the published server contract: every cycle derives authority from a
 * FRESH GET /api/v1/drafts/:id (ownership math is injected via `isUserTurn`),
 * sends If-Match plus a deterministic Idempotency-Key, and ALWAYS stops at
 * user turn, completed board, conflict, error, or cancel. Generation tokens
 * make cancel/restart safe while a POST is in flight; a single-flight flag
 * guarantees at most one outstanding cpu-pick. The only timing primitive is
 * delay() — no wall-clock reads anywhere.
 */

/** Minimal slice of GET /api/v1/drafts/:id the runner reasons about. */
export interface MockRunnerDraft {
  version: number;
  status: string;
  nextOverallPick: number;
  currentSequence: number;
  /** Board capacity (rounds x teams). When provided, a cursor beyond it
   * terminates the burst as "complete" even if the next slot is the user's
   * — otherwise a full board plus a user-turn fold would report "Your turn"
   * forever instead of finishing. */
  boardSize?: number | undefined;
  teams: { slot: number; displayName: string; isUserTeam: boolean }[];
}

/** 200 payload of POST /api/v1/drafts/:id/cpu-pick (published contract). */
export interface MockCpuPickResult {
  pick: {
    playerId: string;
    displayName: string;
    slotPosition: string;
    isBench: boolean;
    sequence: number;
  };
  evidence: {
    personalityKey: string | null;
    personalityVersion: string | null;
    decisionChecksum: string;
    selectionScore: number;
    decisionSeed: string;
  };
  authoritative: {
    version: number;
    status: string;
    currentSequence: number;
    nextOverallPick: number;
  };
}

/**
 * idle — nothing running · cpuAdvancing — loop or single advance in motion ·
 * paused — auto-advance suspended by the user · completing — final pick seen ·
 * error — conflict/failure settled, manual retry available.
 */
export type MockRunnerPhase = "idle" | "cpuAdvancing" | "paused" | "completing" | "error";

export interface UseMockRunnerOptions {
  getDraft: () => Promise<MockRunnerDraft>;
  /** Snake-slot math over fresh data only — never cached ownership. */
  isUserTurn: (draft: MockRunnerDraft) => boolean;
  /** Single polite-region announcement channel owned by the room. */
  announce: (message: string) => void;
  onPickCommitted: (result: MockCpuPickResult) => void;
  /** Delay between automatic picks in ms (defaults to NORMAL pacing). */
  speedMs?: number | undefined;
}

export interface MockRunnerController {
  phase: MockRunnerPhase;
  progressText: string;
  advancing: boolean;
  canAdvance: boolean;
  advanceOnce: () => Promise<void>;
  startAutoAdvance: () => Promise<void>;
  pause: () => void;
  resume: () => Promise<void>;
  cancel: () => void;
}

type Outcome =
  | "committed"
  | "user-turn"
  | "complete"
  | "inactive"
  | "conflict"
  | "cpu-turn-skipped"
  | "rate-limited"
  | "error";

type Evaluation =
  | { kind: "ready"; draft: MockRunnerDraft }
  | { kind: "user-turn"; draft: MockRunnerDraft }
  | { kind: "complete" }
  | { kind: "inactive"; status: string };

interface ProblemLike {
  type?: string | undefined;
  detail?: string | undefined;
  error?: { type?: string | undefined; detail?: string | undefined } | undefined;
  data?: unknown;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Deterministic and retry-safe across retries of the same draft state. */
export function cpuIdempotencyKey(
  draftId: string,
  nextOverallPick: number,
  version: number,
): string {
  return `cpu-${draftId}-${String(nextOverallPick)}-${String(version)}`;
}

const DEFAULT_SPEED_MS = 3_500;
/** Hard ceiling for one cpu-pick HTTP round trip. A hung connection must
 * surface as a failed cycle (announced, retryable) — never as a permanently
 * leaked in-flight lock that silently disables all future advancement. */
const CPU_REQUEST_TIMEOUT_MS = 15_000;

function problemType(body: ProblemLike | null): string {
  return body?.error?.type ?? body?.type ?? "";
}

function problemDetail(body: ProblemLike | null): string | null {
  return body?.error?.detail ?? body?.detail ?? null;
}

function extractResult(body: ProblemLike | null): MockCpuPickResult | null {
  const raw: unknown = body?.data ?? body;
  const candidate =
    raw !== null && typeof raw === "object" ? (raw as Partial<MockCpuPickResult>) : null;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    candidate.pick === undefined ||
    candidate.authoritative === undefined
  ) {
    return null;
  }
  return candidate as MockCpuPickResult;
}

export function useMockRunner(
  draftId: string,
  options: UseMockRunnerOptions,
): MockRunnerController {
  const [phase, setPhase] = useState<MockRunnerPhase>("idle");
  const [progressText, setProgressText] = useState("Mock controls ready.");
  const [advancing, setAdvancing] = useState(false);

  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  /** Bumped by cancel/restart/unmount; stale async work drops itself. */
  const generationRef = useRef(0);
  const inFlightRef = useRef(false);
  const autoEnabledRef = useRef(false);
  const phaseRef = useRef<MockRunnerPhase>("idle");

  const enterPhase = useCallback((next: MockRunnerPhase): void => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  useEffect(
    () => () => {
      generationRef.current += 1;
      autoEnabledRef.current = false;
    },
    [],
  );

  /** Fresh authoritative read + turn classification. No side effects. */
  const evaluate = useCallback(async (generation: number): Promise<Evaluation | "cancelled"> => {
    const draft = await optionsRef.current.getDraft();
    if (generation !== generationRef.current) return "cancelled";
    if (draft.status === "COMPLETED") return { kind: "complete" };
    // Board-full precedes turn ownership: a completed board is terminal even
    // when the next computed slot belongs to the user (snake fold).
    if (typeof draft.boardSize === "number" && draft.nextOverallPick > draft.boardSize) {
      return { kind: "complete" };
    }
    if (optionsRef.current.isUserTurn(draft)) return { kind: "user-turn", draft };
    if (draft.status !== "ACTIVE") return { kind: "inactive", status: draft.status };
    return { kind: "ready", draft };
  }, []);

  /** Claimed SYNCHRONOUSLY at cycle entry so two rapid triggers can never
   * both pass the guard before the first await suspends. */
  const claimFlight = useCallback((): boolean => {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    setAdvancing(true);
    return true;
  }, []);

  const releaseFlight = useCallback((): void => {
    // Always clear the flight flags; stale generations simply drop their
    // results before any other state write above.
    inFlightRef.current = false;
    setAdvancing(false);
  }, []);

  /** POST cpu-pick for an already-evaluated ready draft. Announces only on
   * terminal outcomes so an automatic burst stays announcement-silent until
   * it settles. Requests carry a hard timeout: a dead connection must fail
   * the cycle (recoverable) instead of leaking the in-flight lock forever. */
  const commit = useCallback(
    async (generation: number, draft: MockRunnerDraft): Promise<Outcome | "cancelled"> => {
      const response = await fetch(`/api/v1/drafts/${draftId}/cpu-pick`, {
        method: "POST",
        headers: {
          "If-Match": String(draft.version),
          "Idempotency-Key": cpuIdempotencyKey(draftId, draft.nextOverallPick, draft.version),
        },
        signal: AbortSignal.timeout(CPU_REQUEST_TIMEOUT_MS),
      });
      if (generation !== generationRef.current) return "cancelled";
      const body = (await response.json().catch(() => null)) as ProblemLike | null;

      if (!response.ok) {
        if (response.status === 409 && problemType(body).includes("cpu-turn")) {
          // Ownership moved under us — resync and report whose turn it is.
          const fresh = await optionsRef.current
            .getDraft()
            .catch((): MockRunnerDraft | null => null);
          if (generation !== generationRef.current || fresh === null) return "cancelled";
          enterPhase("idle");
          if (optionsRef.current.isUserTurn(fresh)) {
            const message = `Your turn — overall pick ${String(fresh.nextOverallPick)}.`;
            setProgressText(message);
            optionsRef.current.announce(message);
            return "user-turn";
          }
          setProgressText("CPU turn skipped — board re-synced.");
          optionsRef.current.announce("CPU turn skipped — board re-synced.");
          return "cpu-turn-skipped";
        }
        if (response.status === 409) {
          // Stale authority: resync so the host surface can catch up.
          try {
            await optionsRef.current.getDraft();
          } catch {
            // Resync failure surfaces through the conflict message below.
          }
          if (generation !== generationRef.current) return "cancelled";
          enterPhase("error");
          setProgressText("Out-of-date board detected — re-synced. Advance again.");
          optionsRef.current.announce("Out-of-date board detected — re-synced.");
          return "conflict";
        }
        if (response.status === 429) {
          enterPhase("error");
          setProgressText("CPU pick was rate-limited — wait a moment.");
          optionsRef.current.announce("CPU pick was rate-limited.");
          return "rate-limited";
        }
        enterPhase("error");
        setProgressText(problemDetail(body) ?? "CPU pick failed.");
        optionsRef.current.announce(problemDetail(body) ?? "CPU pick failed.");
        return "error";
      }

      const result = extractResult(body);
      if (result === null) {
        enterPhase("error");
        setProgressText("CPU pick response could not be read.");
        optionsRef.current.announce("CPU pick failed — malformed response.");
        return "error";
      }
      optionsRef.current.onPickCommitted(result);
      if (result.authoritative.status === "COMPLETED") {
        autoEnabledRef.current = false;
        enterPhase("completing");
        setProgressText(`Draft complete — ${result.pick.displayName} was the final pick.`);
        optionsRef.current.announce("Draft complete.");
        return "complete";
      }
      setProgressText(
        `CPU drafted ${result.pick.displayName} — overall pick ${String(
          result.authoritative.nextOverallPick,
        )} is next.`,
      );
      return "committed";
    },
    [draftId, enterPhase],
  );

  /** One guarded evaluate→settle-or-commit cycle shared by both paths.
   * Settles (user turn / complete / inactive) announce EXACTLY once here. */
  const runCycle = useCallback(
    async (generation: number): Promise<Outcome | "cancelled"> => {
      if (!claimFlight()) return "cancelled";
      try {
        const evaluated = await evaluate(generation);
        if (evaluated === "cancelled") return "cancelled";
        switch (evaluated.kind) {
          case "ready":
            return await commit(generation, evaluated.draft);
          case "user-turn": {
            enterPhase("idle");
            const message = `Your turn — overall pick ${String(evaluated.draft.nextOverallPick)}.`;
            setProgressText(message);
            optionsRef.current.announce(message);
            return "user-turn";
          }
          case "complete": {
            enterPhase("completing");
            setProgressText("Draft complete.");
            optionsRef.current.announce("Draft complete.");
            return "complete";
          }
          case "inactive": {
            enterPhase("idle");
            const message = `Draft is ${evaluated.status.toLowerCase()} — CPU picks are suspended.`;
            setProgressText(message);
            optionsRef.current.announce(message);
            return "inactive";
          }
          default:
            return "cancelled";
        }
      } finally {
        releaseFlight();
      }
    },
    [claimFlight, commit, enterPhase, evaluate, releaseFlight],
  );

  /** Live read through a call so control-flow narrowing never freezes the
   * flag's type (pause/cancel mutate it between awaits). */
  const autoActive = useCallback((): boolean => autoEnabledRef.current, []);

  /** Auto-advance loop: fresh evaluation → paced POST → repeat. Any
   * non-committed outcome terminates; pause/cancel flip the refs the loop
   * re-checks around every await. */
  const beginAuto = useCallback(async (): Promise<void> => {
    if (phaseRef.current === "cpuAdvancing") return;
    generationRef.current += 1;
    const generation = generationRef.current;
    autoEnabledRef.current = true;
    enterPhase("cpuAdvancing");
    try {
      while (autoActive() && generation === generationRef.current) {
        const outcome = await runCycle(generation);
        if (outcome !== "committed") return;
        if (!(autoActive() && generation === generationRef.current)) return;
        await delay(optionsRef.current.speedMs ?? DEFAULT_SPEED_MS);
      }
    } catch {
      if (generation === generationRef.current) {
        autoEnabledRef.current = false;
        enterPhase("error");
        setProgressText("Auto-advance hit an unexpected error.");
        optionsRef.current.announce("Auto-advance stopped — an unexpected error occurred.");
      }
    }
  }, [autoActive, enterPhase, runCycle]);

  const startAutoAdvance = useCallback((): Promise<void> => beginAuto(), [beginAuto]);

  const resume = useCallback((): Promise<void> => {
    if (phaseRef.current !== "paused") return Promise.resolve();
    return beginAuto();
  }, [beginAuto]);

  const pause = useCallback((): void => {
    if (phaseRef.current !== "cpuAdvancing") return;
    autoEnabledRef.current = false;
    enterPhase("paused");
    setProgressText("Auto-advance paused.");
  }, [enterPhase]);

  /** Bumps the generation so any in-flight cpu-pick result is dropped. */
  const cancel = useCallback((): void => {
    const wasRunning = phaseRef.current === "cpuAdvancing" || phaseRef.current === "paused";
    generationRef.current += 1;
    autoEnabledRef.current = false;
    enterPhase("idle");
    setProgressText("Mock controls ready.");
    if (wasRunning) optionsRef.current.announce("Auto-advance cancelled.");
  }, [enterPhase]);

  const advanceOnce = useCallback(async (): Promise<void> => {
    if (inFlightRef.current || phaseRef.current === "completing") return;
    generationRef.current += 1;
    const generation = generationRef.current;
    try {
      await runCycle(generation);
    } catch {
      enterPhase("error");
      setProgressText("Could not advance — request failed.");
      optionsRef.current.announce("Could not advance — request failed.");
    }
  }, [enterPhase, runCycle]);

  return {
    phase,
    progressText,
    advancing,
    canAdvance: !advancing && phase !== "completing",
    advanceOnce,
    startAutoAdvance,
    pause,
    resume,
    cancel,
  };
}
