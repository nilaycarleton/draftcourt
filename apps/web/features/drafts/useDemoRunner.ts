"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Guest demo draft runner (Phase 3D).
 *
 * Fork of useMockRunner adapted for unauthenticated demo drafts.
 * Uses capability token from cookie or localStorage recovery code.
 */

export type DemoPacingSpeed = "SLOW" | "NORMAL" | "INSTANT";

export const DEMO_SPEED_MS: Record<DemoPacingSpeed, number> = {
  SLOW: 10_000,
  NORMAL: 3_500,
  INSTANT: 250,
};

export interface DemoRunnerState {
  status: "idle" | "running" | "paused" | "completed" | "error" | "expired";
  speed: DemoPacingSpeed;
  autoAdvance: boolean;
  lastError: string | null;
  currentCpuTeam: { slot: number; personalityKey: string | null } | null;
  progress: { current: number; total: number };
}

interface DemoDraftState {
  status: string;
  version: number;
  nextOverallPick: number;
  boardSize: number;
  teams: { slot: number; isUserTeam: boolean; personalityKey: string | null }[];
}

interface CpuPickResponse {
  data?: {
    authoritative?: { nextOverallPick: number };
    evidence?: { personalityKey: string };
  };
  error?: { type: string; detail?: string };
}

export function useDemoRunner(
  draftId: string,
  _capabilityToken: string,
  initialState: DemoDraftState,
) {
  const [state, setState] = useState<DemoRunnerState>({
    status:
      initialState.status === "ACTIVE"
        ? "idle"
        : (initialState.status.toLowerCase() as DemoRunnerState["status"]),
    speed: "NORMAL",
    autoAdvance: false,
    lastError: null,
    currentCpuTeam: null,
    progress: { current: initialState.nextOverallPick - 1, total: initialState.boardSize },
  });

  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const versionRef = useRef(initialState.version);
  const nextPickRef = useRef(initialState.nextOverallPick);

  const savePacing = useCallback((speed: DemoPacingSpeed, autoAdvance: boolean) => {
    setState((s) => ({ ...s, speed, autoAdvance }));
    try {
      localStorage.setItem("dc.demo.pacing", JSON.stringify({ speed, autoAdvance }));
    } catch {
      // ignore
    }
  }, []);

  const loadPacing = useCallback(() => {
    try {
      const stored = localStorage.getItem("dc.demo.pacing");
      if (stored) {
        const parsed = JSON.parse(stored) as { speed?: DemoPacingSpeed; autoAdvance?: boolean };
        const storedSpeed = parsed.speed;
        if (storedSpeed !== undefined) {
          setState((s) => ({ ...s, speed: storedSpeed }));
        }
        const storedAuto = parsed.autoAdvance;
        if (storedAuto !== undefined) {
          setState((s) => ({ ...s, autoAdvance: storedAuto }));
        }
      }
    } catch {
      // ignore
    }
  }, []);

  // Load pacing from localStorage on mount
  useEffect(() => {
    loadPacing();
  }, [loadPacing]);

  const advanceOneCpu = useCallback(async () => {
    if (state.status !== "idle" && state.status !== "running") return;
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();

    const gen = ++generationRef.current;
    setState((s) => ({ ...s, status: "running", lastError: null }));

    try {
      const currentVersion = versionRef.current;
      const currentNext = nextPickRef.current;
      const response = await fetch(`/api/v1/demo-drafts/${draftId}/cpu-pick`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": String(currentVersion),
          "Idempotency-Key": `demo-cpu-${draftId}-${String(currentNext)}-${String(currentVersion)}`,
        },
        signal: abortRef.current.signal,
      });

      if (gen !== generationRef.current) return; // stale

      const data = (await response.json().catch(() => null)) as CpuPickResponse | null;
      if (!response.ok) {
        if (response.status === 401 || response.status === 409) {
          const maybeExpired = data?.error?.type === "/problems/demo-expired";
          if (maybeExpired) {
            setState((s) => ({
              ...s,
              status: "expired",
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guarded access
              lastError: data?.error?.detail ?? "Demo expired",
            }));
            return;
          }
          // On version conflict, sync refs from authoritative payload if present
          if (response.status === 409) {
            const auth = (
              data?.error as
                { authoritative?: { version?: number; nextOverallPick?: number } } | undefined
            )?.authoritative;
            if (auth) {
              if (typeof auth.version === "number") versionRef.current = auth.version;
              if (typeof auth.nextOverallPick === "number") {
                const nextPickValue: number = auth.nextOverallPick;
                nextPickRef.current = nextPickValue;
                setState((s) => ({
                  ...s,
                  progress: { current: nextPickValue - 1, total: s.progress.total },
                }));
              }
            }
          }
        }
        throw new Error(data?.error?.detail ?? "CPU pick failed");
      }

      if (data === null) {
        throw new Error("CPU pick failed: empty response");
      }
      const responseData = data;

      // Update authoritative cursor and progress
      const authoritativeNext =
        responseData.data?.authoritative?.nextOverallPick ?? nextPickRef.current + 1;
      // Derive new version: increment optimistically; server authoritative version would be +1
      versionRef.current += 1;
      nextPickRef.current = authoritativeNext;
      const userSlot = initialState.teams.find((t) => t.isUserTeam)?.slot ?? 1;
      const teamCount = initialState.teams.length;
      const round = Math.ceil(authoritativeNext / teamCount);
      const posInRound = ((authoritativeNext - 1) % teamCount) + 1;
      const nextSlot = round % 2 === 1 ? posInRound : teamCount + 1 - posInRound;

      setState((s) => ({
        ...s,
        status: "idle",
        progress: { current: authoritativeNext - 1, total: initialState.boardSize },
        currentCpuTeam: responseData.data?.evidence
          ? { slot: nextSlot, personalityKey: responseData.data.evidence.personalityKey }
          : null,
      }));

      // Check if next is user turn
      if (nextSlot === userSlot) {
        return; // stop auto-advance
      }

      // Auto-advance if enabled
      if (state.autoAdvance) {
        const delay = DEMO_SPEED_MS[state.speed];
        if (delay > 0) {
          await new Promise((r) => setTimeout(r, delay));
        }
        if (gen === generationRef.current) {
          void advanceOneCpu();
        }
      }
    } catch (error) {
      if (gen !== generationRef.current) return;
      if (error instanceof Error && error.name === "AbortError") return;
      setState((s) => ({
        ...s,
        status: "error",
        lastError: error instanceof Error ? error.message : "CPU pick failed",
      }));
    }
  }, [
    draftId,
    initialState.boardSize,
    initialState.teams,
    state.autoAdvance,
    state.speed,
    state.status,
  ]);

  const startAutoAdvance = useCallback(() => {
    setState((s) => ({ ...s, autoAdvance: true, status: "running" }));
    void advanceOneCpu();
  }, [advanceOneCpu]);

  const pause = useCallback(() => {
    setState((s) => ({ ...s, autoAdvance: false, status: "paused" }));
  }, []);

  const cancel = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    generationRef.current++;
    setState((s) => ({ ...s, status: "idle", autoAdvance: false }));
  }, []);

  const setSpeed = useCallback(
    (speed: DemoPacingSpeed) => {
      savePacing(speed, state.autoAdvance);
    },
    [savePacing, state.autoAdvance],
  );

  const toggleAutoAdvance = useCallback(() => {
    savePacing(state.speed, !state.autoAdvance);
    if (!state.autoAdvance) {
      void advanceOneCpu();
    }
  }, [state.autoAdvance, state.speed, savePacing, advanceOneCpu]);

  // Handle completion
  useEffect(() => {
    if (state.progress.current >= state.progress.total) {
      setState((s) => ({ ...s, status: "completed" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.progress.current, state.progress.total]);

  return {
    state,
    advanceOneCpu,
    startAutoAdvance,
    pause,
    cancel,
    setSpeed,
    toggleAutoAdvance,
  };
}
