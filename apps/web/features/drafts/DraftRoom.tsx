"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RecommendationOutput } from "@draftcourt/domain";
import { DraftBoard, Sheet, Tabs } from "@draftcourt/ui";
import { PreferenceContributionChips } from "./PreferenceContributionChips";
import { StrategyEvidenceCard, type DraftRoomStrategyEvidence } from "./StrategyEvidenceCard";
import { MockDraftControls } from "./MockDraftControls";
import { MockStatusStrip, type MockStatusStripTeam } from "./MockStatusStrip";
import { MOCK_SPEED_MS, readMockPacing, writeMockPacing, type MockPacingSpeed } from "./mockPacing";
import { useMockRunner } from "./useMockRunner";

/**
 * Live draft room (BUILD_SPEC section 9.2; Impeccable shape:
 * docs/design/phase2-shape.md). Optimistic pick display followed by
 * authoritative reconciliation; version conflicts restore server state and
 * explain the change; keyboard shortcuts per spec (`/` `D` `U` `R` `B` `M`
 * `?` Escape); a single polite live region announces picks and updates.
 *
 * Board: virtualized visual snake grid (`@draftcourt/ui` DraftBoard) plus a
 * semantic per-pick table alternative for assistive technology and
 * non-visual use (lazy-rendered on expand so large drafts never pay the
 * double-DOM cost).
 *
 * Mobile: explicit tabs — Recommendations / Board / Available players /
 * My roster. Panels stay mounted when switching so in-progress search text,
 * recommendation state and scroll positions survive; opponent rosters open
 * in a sheet without losing room state; focus returns to the invoking
 * control after close. On desktop (>900px CSS) every panel is visible at
 * once and the tab bar is hidden via CSS.
 */

export interface DraftRoomTeamAssignment {
  playerId: string;
  playerName?: string;
  sequence: number;
  round?: number | null;
  pickInRound?: number | null;
  isKeeper?: boolean;
  slotPosition?: string;
  isBench?: boolean;
}

export interface DraftRoomProps {
  draftId: string;
  initial: {
    version: number;
    status: string;
    nextOverallPick: number;
    currentSequence: number;
    boardSize: number;
    settingsSnapshot: {
      teamCount: number;
      rounds: number;
      userDraftSlot: number;
      scoringRules: { stat: string; weight: number }[];
      teams: { slot: number; displayName: string; isUserTeam: boolean }[];
    };
    teams: {
      slot: number;
      displayName: string;
      isUserTeam: boolean;
      assignments: DraftRoomTeamAssignment[];
    }[];
    /** Phase 3B: immutable strategy evidence parsed server-side from the
     * stored snapshot. Optional so pre-3B callers/tests compile unchanged. */
    strategy?: DraftRoomStrategyEvidence | undefined;
    /** Phase 3C: mock-draft context. Present ONLY for MOCK drafts; absent on
     * real drafts so no CPU controls can ever appear there. */
    mock?: { simSeed: string | null; teams: MockStatusStripTeam[] } | undefined;
  };
}

interface PoolPlayer {
  playerId: string;
  displayName: string;
  positions: string[];
  teamAbbreviation?: string | null;
}

interface DraftReadModel {
  version: number;
  status: string;
  nextOverallPick: number;
  currentSequence: number;
  teams: {
    slot: number;
    displayName: string;
    isUserTeam: boolean;
    assignments: DraftRoomTeamAssignment[];
  }[];
}

type TabValue = "recommendations" | "board" | "players" | "roster";

const MOBILE_QUERY = "(max-width: 899px)";

function slotForPick(pick: number, teams: number): number {
  const positionInRound = ((pick - 1) % teams) + 1;
  const round = Math.ceil(pick / teams);
  return round % 2 === 1 ? positionInRound : teams + 1 - positionInRound;
}

const label = (value: number | undefined): string => String(value ?? "");

interface BoardPositionedAssignment extends DraftRoomTeamAssignment {
  round: number;
  pickInRound: number;
}

function hasBoardPosition(
  assignment: DraftRoomTeamAssignment,
): assignment is BoardPositionedAssignment {
  return typeof assignment.round === "number" && typeof assignment.pickInRound === "number";
}

export function DraftRoom({ draftId, initial }: DraftRoomProps) {
  const [version, setVersion] = useState(initial.version);
  const [status, setStatus] = useState(initial.status);
  const [nextPick, setNextPick] = useState(initial.nextOverallPick);
  const [teams, setTeams] = useState(initial.teams);
  const [optimisticIds, setOptimisticIds] = useState<Set<string>>(() => new Set());
  const [pool, setPool] = useState<PoolPlayer[]>([]);
  const [search, setSearch] = useState("");
  const [recs, setRecs] = useState<RecommendationOutput | null>(null);
  const [calculating, setCalculating] = useState(true);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Mobile tab state (explicit tabs are a Phase 2 acceptance requirement).
  const [isMobile, setIsMobile] = useState(false);
  const [activeTab, setActiveTab] = useState<TabValue>("recommendations");
  // Opponent roster sheet + focus restore to its invoking control.
  const [rosterTeamSlot, setRosterTeamSlot] = useState<number | null>(null);
  const rosterInvokerRef = useRef<HTMLElement | null>(null);
  // Semantic board table renders only after first expansion (double-DOM cost).
  const [dataTableOpen, setDataTableOpen] = useState(false);
  // Visible confirmation affordance for destructive actions (`D` draft key,
  // undo via the `U` key OR the status-bar button): first activation arms
  // ("press again"), second activation executes, Escape disarms. Announced
  // through the shared polite live region.
  const [armedAction, setArmedAction] = useState<"draft" | "undo" | null>(null);
  const [selectedPoolIndex, setSelectedPoolIndex] = useState(0);
  // Dual-channel feedback: the same announcement feeds the polite live
  // region AND a visible status strip — sighted users get confirmations,
  // errors and help without relying on a screen reader.
  const noteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const update = (): void => {
      setIsMobile(query.matches);
    };
    update();
    query.addEventListener("change", update);
    return () => {
      query.removeEventListener("change", update);
    };
  }, []);

  const draftedIds = useMemo(
    () => new Set(teams.flatMap((team) => team.assignments.map((a) => a.playerId))),
    [teams],
  );

  const playerNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const team of teams) {
      for (const assignment of team.assignments) {
        map.set(assignment.playerId, assignment.playerName ?? "Unknown player");
      }
    }
    return map;
  }, [teams]);

  const boardPicks = useMemo(
    () =>
      teams.flatMap((team) =>
        team.assignments.filter(hasBoardPosition).map((a) => ({
          round: a.round,
          pickInRound: a.pickInRound,
          teamSlot: team.slot,
          overallPick: (a.round - 1) * initial.settingsSnapshot.teamCount + a.pickInRound,
          playerName: a.playerName ?? playerNameById.get(a.playerId) ?? "Unknown player",
          isKeeper: a.isKeeper ?? false,
        })),
      ),
    [initial.settingsSnapshot.teamCount, playerNameById, teams],
  );

  // Player pool for search-to-draft (loaded once).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/players?limit=600")
      .then((response) => response.json())
      .then(
        (body: {
          data?: {
            id: string;
            displayName: string;
            positions?: string[];
            team?: { abbreviation?: string } | null;
          }[];
        }) => {
          if (!cancelled && Array.isArray(body.data)) {
            setPool(
              body.data.map((p) => ({
                playerId: p.id,
                displayName: p.displayName,
                positions: p.positions ?? [],
                teamAbbreviation: p.team?.abbreviation ?? null,
              })),
            );
          }
        },
      )
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshRecommendations = useCallback(async (): Promise<void> => {
    setCalculating(true);
    try {
      const response = await fetch(`/api/v1/drafts/${draftId}/recommendations`);
      const bodyJson = (await response.json()) as { data?: RecommendationOutput };
      if (response.ok && bodyJson.data !== undefined) setRecs(bodyJson.data);
    } catch {
      // Keep calculating state; retried on next pick or manual refresh.
    } finally {
      setCalculating(false);
    }
  }, [draftId]);

  /** Re-syncs room state from the authoritative read model after any
   * mutation, conflict, undo, or reload — the server is the source of truth,
   * optimistic UI is display-only and always reconciled here. */
  const refreshBoard = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/v1/drafts/${draftId}`);
      if (!response.ok) return;
      const bodyJson = (await response.json()) as { data?: DraftReadModel };
      if (bodyJson.data === undefined) return;
      setVersion(bodyJson.data.version);
      setStatus(bodyJson.data.status);
      setNextPick(bodyJson.data.nextOverallPick);
      setTeams(bodyJson.data.teams);
      setOptimisticIds(new Set());
    } catch {
      // Transient network error: keep current view; next action retries.
    }
  }, [draftId]);

  // ---------------------------------------------------------------------------
  // Phase 3C mock orchestration (MOCK drafts only — real drafts never mount
  // the runner or its controls). The runner derives every transition from
  // fresh authoritative reads; pacing lives in localStorage. Declared AFTER
  // `announce` (below) so the shared live region exists first — the mock
  // wiring itself is hoisted into a child effect via optionsRef.
  // ---------------------------------------------------------------------------
  const isMock = initial.mock !== undefined;
  const [mockPacing, setMockPacing] = useState<{ speed: MockPacingSpeed; autoAdvance: boolean }>(
    () => ({ speed: "NORMAL", autoAdvance: false }),
  );
  useEffect(() => {
    // localStorage is unavailable during SSR; read it lazily post-hydration.
    // (The setState here is guarded to run once per mount — the lint rule
    // flags any effect-local setState, so this is a narrow accepted use.)
    if (!isMock) return;
    let cancelled = false;
    const stored = readMockPacing();
    queueMicrotask(() => {
      if (!cancelled) {
        setMockPacing((current) =>
          current.speed === stored.speed && current.autoAdvance === stored.autoAdvance
            ? current
            : stored,
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isMock]);

  const getRunnerDraft = useCallback(async () => {
    // Hard request ceiling: a dead connection must fail the runner's cycle
    // (announced + retryable) rather than silently freezing orchestration.
    const response = await fetch(`/api/v1/drafts/${draftId}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const bodyJson = (await response.json()) as { data?: DraftReadModel };
    if (!response.ok || bodyJson.data === undefined) throw new Error("draft read failed");
    // Keep the room in sync with whatever the runner just observed.
    setVersion(bodyJson.data.version);
    setStatus(bodyJson.data.status);
    setNextPick(bodyJson.data.nextOverallPick);
    setTeams(bodyJson.data.teams);
    setOptimisticIds(new Set());
    return { ...bodyJson.data, boardSize: initial.boardSize };
  }, [draftId, initial.boardSize]);

  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      if (cancelled) return;
      await refreshRecommendations();
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [refreshRecommendations]);

  // Dual-channel feedback: the same announcement feeds the polite live
  // region AND a visible status strip — sighted users get confirmations,
  // errors and help without relying on a screen reader. Declared before the
  // callbacks that use it so memoization is preserved.
  const announce = useCallback((message: string): void => {
    setAnnouncement(message);
    if (noteTimerRef.current !== null) clearTimeout(noteTimerRef.current);
    noteTimerRef.current = setTimeout(() => {
      setAnnouncement("");
    }, 6000);
  }, []);

  // Phase 3C runner wiring (after `announce` exists). The hook stores the
  // latest options in a ref internally, so inline object identity is fine.
  const isUserTurnDerived = useCallback(
    (draft: { nextOverallPick: number }): boolean =>
      slotForPick(draft.nextOverallPick, initial.settingsSnapshot.teamCount) ===
      initial.settingsSnapshot.userDraftSlot,
    [initial.settingsSnapshot.teamCount, initial.settingsSnapshot.userDraftSlot],
  );

  const mockRunner = useMockRunner(draftId, {
    getDraft: getRunnerDraft,
    isUserTurn: isUserTurnDerived,
    announce,
    speedMs: MOCK_SPEED_MS[mockPacing.speed],
    onPickCommitted: () => {
      void refreshRecommendations();
    },
  });

  // Phase 3B advisory warnings announce ONCE per player via the shared polite
  // region on first appearance; they never disable the Draft buttons.
  const announcedWarningsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (recs === null) return;
    for (const entry of recs.top3) {
      if (!entry.warnings || entry.warnings.length === 0) continue;
      if (announcedWarningsRef.current.has(entry.playerId)) continue;
      announcedWarningsRef.current.add(entry.playerId);
      announce(`Warning: ${entry.warnings.join(" ")}`);
    }
  }, [announce, recs]);

  const makePickRequest = useCallback(
    async (playerId: string): Promise<void> => {
      if (draftedIds.has(playerId) || optimisticIds.size > 0) return;
      const playerLabel =
        pool.find((p) => p.playerId === playerId)?.displayName ??
        playerNameById.get(playerId) ??
        "Selected player";
      setOptimisticIds(new Set([playerId]));
      try {
        const response = await fetch(`/api/v1/drafts/${draftId}/picks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": ["pick", draftId, playerId, label(version)].join("-"),
            "If-Match": String(version),
          },
          body: JSON.stringify({ playerId }),
        });
        const bodyJson = (await response.json()) as {
          data?: { authoritative?: { nextOverallPick?: number; version?: number } };
          error?: {
            detail?: string;
            authoritative?: { nextOverallPick: number; version: number; status: string };
          };
        };
        if (response.status === 409 && bodyJson.error?.authoritative !== undefined) {
          setConflictMessage(
            bodyJson.error.detail ??
              "The draft changed while you were picking — the Board tab now shows the authoritative state.",
          );
        } else if (response.ok && bodyJson.data?.authoritative) {
          const authoritativeNext = bodyJson.data.authoritative.nextOverallPick ?? nextPick + 1;
          const draftedBy = initial.settingsSnapshot.teams.find(
            (team) =>
              team.slot === slotForPick(authoritativeNext - 1, initial.settingsSnapshot.teamCount),
          );
          announce(`${playerLabel} drafted by ${draftedBy?.displayName ?? "a team"}.`);
        } else {
          setOptimisticIds(new Set());
          announce(bodyJson.error?.detail ?? "The pick was not accepted.");
        }
      } catch {
        setOptimisticIds(new Set());
        announce("Network error — the pick was not recorded.");
      } finally {
        await refreshBoard();
        await refreshRecommendations();
      }
    },
    [
      announce,
      draftedIds,
      draftId,
      initial.settingsSnapshot.teams,
      initial.settingsSnapshot.teamCount,
      nextPick,
      playerNameById,
      optimisticIds.size,
      pool,
      refreshBoard,
      refreshRecommendations,
      version,
    ],
  );

  const undoLatest = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/v1/drafts/${draftId}/undo`, {
        method: "POST",
        headers: {
          "Idempotency-Key": ["undo", draftId, label(version)].join("-"),
          "If-Match": String(version),
        },
      });
      if (response.ok) {
        announce("Last pick undone.");
      }
    } catch {
      announce("Undo failed — try again.");
    } finally {
      await refreshBoard();
      await refreshRecommendations();
    }
  }, [announce, draftId, refreshBoard, refreshRecommendations, version]);

  const activateTabAndFocus = useCallback((tab: TabValue): void => {
    setActiveTab(tab);
    document.getElementById(`dc-panel-${tab}`)?.focus();
  }, []);

  const readOnly = status === "COMPLETED" || status === "ABANDONED";
  const statusLabel: Record<string, string> = {
    SETUP: "Setup",
    ACTIVE: "Live",
    PAUSED: "Paused",
    COMPLETED: "Completed",
    ABANDONED: "Abandoned",
  };

  // One shared two-step undo for BOTH activation paths (status-bar button and
  // the `U` shortcut — Impeccable clarify finding 2): first activation arms,
  // second confirms, Escape disarms. The armed state is visible (button label
  // + data-armed) and announced; no blocking browser dialog.
  const armOrUndo = useCallback((): void => {
    if (readOnly) return;
    if (armedAction === "undo") {
      setArmedAction(null);
      void undoLatest();
    } else {
      setArmedAction("undo");
      announce("Press again to undo the last pick. Escape cancels.");
    }
  }, [announce, armedAction, readOnly, undoLatest]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = q ? pool.filter((p) => p.displayName.toLowerCase().includes(q)) : pool;
    return base.slice(0, 12);
  }, [pool, search]);

  // Keyboard shortcuts (spec section 9.2). Never fire while typing.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;

      if (event.key === "/" && !typing) {
        event.preventDefault();
        activateTabAndFocus("players");
        requestAnimationFrame(() => searchRef.current?.focus());
        return;
      }
      if (typing) return;

      if (event.key === "ArrowDown" && activeTab === "players") {
        event.preventDefault();
        setSelectedPoolIndex((index) => Math.min(filtered.length - 1, index + 1));
        setArmedAction(null);
        return;
      }
      if (event.key === "ArrowUp" && activeTab === "players") {
        event.preventDefault();
        setSelectedPoolIndex((index) => Math.max(0, index - 1));
        setArmedAction(null);
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "escape" && armedAction !== null) {
        setArmedAction(null);
        announce("Cancelled.");
        return;
      }
      switch (key) {
        case "r":
          activateTabAndFocus("recommendations");
          break;
        case "b":
          activateTabAndFocus("board");
          break;
        case "m":
          activateTabAndFocus("roster");
          break;
        case "u":
          event.preventDefault();
          armOrUndo();
          break;
        case "d": {
          event.preventDefault();
          const target = filtered[selectedPoolIndex];
          if (!readOnly && target !== undefined && !draftedIds.has(target.playerId)) {
            if (armedAction === "draft") {
              setArmedAction(null);
              void makePickRequest(target.playerId);
            } else {
              setArmedAction("draft");
              announce(`Draft ${target.displayName}? Press D again to confirm. Escape cancels.`);
            }
          }
          break;
        }
        case "?":
          announce(
            "Shortcuts: slash focuses search. Arrows move through results. D drafts the selected player (press twice). U undoes (press twice). R recommendations. B board. M my roster.",
          );
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    activateTabAndFocus,
    activeTab,
    announce,
    armedAction,
    armOrUndo,
    draftedIds,
    filtered,
    makePickRequest,
    readOnly,
    selectedPoolIndex,
  ]);

  // True turn state (Assessment A P2): the user is on the clock exactly when
  // the current pick belongs to their slot; picksUntilTurn counts picks
  // BEFORE their next turn; once their slot has no remaining pick the
  // counter retires instead of counting impossible turns.
  const userHasRemainingPick = useMemo(() => {
    const { teamCount, rounds, userDraftSlot } = initial.settingsSnapshot;
    for (let pick = Math.max(1, nextPick); pick <= rounds * teamCount; pick++) {
      if (slotForPick(pick, teamCount) === userDraftSlot) return true;
    }
    return false;
  }, [initial.settingsSnapshot, nextPick]);

  const isOnTheClock =
    !readOnly &&
    slotForPick(nextPick, initial.settingsSnapshot.teamCount) ===
      initial.settingsSnapshot.userDraftSlot;

  const picksUntilTurn = useMemo(() => {
    const { teamCount, rounds, userDraftSlot } = initial.settingsSnapshot;
    for (let pick = Math.max(1, nextPick); pick <= rounds * teamCount; pick++) {
      if (slotForPick(pick, teamCount) === userDraftSlot) {
        return pick - nextPick + 1;
      }
    }
    return null;
  }, [initial.settingsSnapshot, nextPick]);

  const myTeam = teams.find((team) => team.isUserTeam);

  const openRosterSheet = useCallback((slot: number): void => {
    rosterInvokerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRosterTeamSlot(slot);
  }, []);

  const closeRosterSheet = useCallback((): void => {
    setRosterTeamSlot(null);
    rosterInvokerRef.current?.focus();
    rosterInvokerRef.current = null;
  }, []);

  const panelHidden = (id: TabValue): boolean => isMobile && activeTab !== id;

  const rosterTeam =
    rosterTeamSlot !== null ? teams.find((team) => team.slot === rosterTeamSlot) : undefined;

  return (
    <div className="dc-draft-room">
      <div aria-live="polite" className="dc-visually-hidden">
        {announcement}
      </div>

      <header className={isOnTheClock ? "dc-status-bar dc-on-clock" : "dc-status-bar"}>
        <span className="dc-status-picks">
          Round {label(Math.ceil(nextPick / initial.settingsSnapshot.teamCount))} · pick{" "}
          {label(nextPick)} of {label(initial.boardSize)}
        </span>
        <span className="dc-status-turn">
          {isOnTheClock
            ? "On the clock — you're picking"
            : userHasRemainingPick && picksUntilTurn !== null
              ? `${label(picksUntilTurn)} ${picksUntilTurn === 1 ? "pick" : "picks"} until your turn`
              : "No further picks for your slot"}
        </span>
        <span data-status={status}>{statusLabel[status] ?? status}</span>
        <button
          type="button"
          disabled={readOnly}
          data-armed={armedAction === "undo" || undefined}
          onClick={armOrUndo}
        >
          {armedAction === "undo" ? "Confirm undo" : "Undo"}
        </button>
      </header>

      {/* Visible counterpart of the polite live region: confirmations,
          errors and shortcut help must be readable without a screen reader
          (Assessment A P1). */}
      {announcement !== "" && (
        <p aria-hidden="true" className="dc-room-note">
          {announcement}
        </p>
      )}

      {conflictMessage !== null && (
        <div role="alert" className="dc-freshness-banner">
          {conflictMessage}
          <button
            type="button"
            onClick={() => {
              setConflictMessage(null);
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Phase 3C mock controls: outside the tab panels, visible on every
          tab; rendered ONLY for MOCK drafts (real drafts never mount CPU
          controls). Pacing changes are presentation-only. */}
      {isMock && (
        <section aria-label="Mock draft controls" className="dc-mock-room-controls">
          {/* The strip (seed/provenance/completed summary) persists into the
              read-only completed state; only interactive controls hide. */}
          <MockStatusStrip
            simSeed={initial.mock?.simSeed ?? null}
            teams={initial.mock?.teams ?? []}
            completedSummary={
              status === "COMPLETED"
                ? {
                    totalPicks: initial.boardSize,
                    userPicks: teams.find((team) => team.isUserTeam)?.assignments.length ?? 0,
                  }
                : undefined
            }
          />
          {!readOnly && (
            <MockDraftControls
              phase={mockRunner.phase}
              progressText={mockRunner.progressText}
              advancing={mockRunner.advancing}
              canAdvance={mockRunner.canAdvance && !readOnly}
              // Server-side PAUSED makes every pick illegal (user and CPU):
              // the controls must say so instead of inviting a guaranteed 409.
              // (readOnly is impossible in this branch — completed drafts never
              // mount interactive controls.)
              disabled={status !== "ACTIVE" || undefined}
              speed={mockPacing.speed}
              autoAdvance={mockPacing.autoAdvance}
              onSpeedChange={(speed) => {
                const next = { ...mockPacing, speed };
                setMockPacing(next);
                writeMockPacing(next);
              }}
              onAutoAdvanceChange={(autoAdvance) => {
                const next = { ...mockPacing, autoAdvance };
                setMockPacing(next);
                writeMockPacing(next);
                if (autoAdvance) void mockRunner.startAutoAdvance();
                else mockRunner.pause();
              }}
              onAdvance={() => {
                void mockRunner.advanceOnce();
              }}
              onPause={() => {
                mockRunner.pause();
              }}
              onResume={() => {
                if (mockPacing.autoAdvance) void mockRunner.startAutoAdvance();
              }}
              onCancel={() => {
                mockRunner.cancel();
              }}
            />
          )}
        </section>
      )}

      {/* Phase 3B strategy evidence: outside the tab panels so it stays
          visible on every tab; visually quieter than recommendations. */}
      <StrategyEvidenceCard strategy={initial.strategy} />

      <Tabs
        value={activeTab}
        onChange={(value) => {
          activateTabAndFocus(value as TabValue);
        }}
        accessibleLabel="Draft room sections"
        tabs={[
          { value: "recommendations", label: "Recommendations" },
          { value: "board", label: "Board" },
          { value: "players", label: "Available players" },
          { value: "roster", label: "My roster" },
        ]}
      />

      <section
        id="dc-panel-recommendations"
        role="tabpanel"
        aria-label="Top three recommendations"
        tabIndex={-1}
        className={panelHidden("recommendations") ? "dc-tab-hidden" : ""}
      >
        <h2 id="dc-recs">Best available</h2>
        <p className="dc-hint dc-recs-status">{calculating ? "Recalculating…" : ""}</p>
        {(recs?.top3 ?? []).length === 0 && !calculating && (
          <p className="dc-hint">No recommendations yet.</p>
        )}
        <ol>
          {(recs?.top3 ?? []).map((entry) => (
            <li key={entry.playerId}>
              <strong>{entry.displayName}</strong> — score {label(entry.draftScore)}
              <small>
                {" "}
                {entry.labels.join(", ")} · {entry.explanation}
              </small>
              <PreferenceContributionChips entry={entry} />
              {!readOnly && (
                <button
                  type="button"
                  disabled={draftedIds.has(entry.playerId) || optimisticIds.has(entry.playerId)}
                  onClick={() => {
                    void makePickRequest(entry.playerId);
                  }}
                >
                  {draftedIds.has(entry.playerId) || optimisticIds.has(entry.playerId)
                    ? "Drafted"
                    : "Draft"}
                </button>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section
        id="dc-panel-board"
        tabIndex={-1}
        aria-labelledby="dc-board-heading"
        className={panelHidden("board") ? "dc-tab-hidden" : ""}
      >
        <h2 id="dc-board-heading">Board</h2>
        <div id="dc-board">
          <DraftBoard
            labelId="dc-board-heading"
            teams={initial.settingsSnapshot.teams.map((team) => ({
              slot: team.slot,
              displayName: team.displayName,
              isUserTeam: team.isUserTeam,
            }))}
            rounds={initial.settingsSnapshot.rounds}
            picks={boardPicks}
            currentOverallPick={nextPick}
            readOnly={readOnly}
            onOpenTeamRoster={openRosterSheet}
            onAnnounce={announce}
          />
        </div>
        <details
          className="dc-board-data"
          onToggle={(event) => {
            setDataTableOpen((event.target as HTMLDetailsElement).open);
          }}
        >
          <summary>Board data table</summary>
          {dataTableOpen && (
            <table className="dc-board-table">
              <caption>Every selection by overall pick.</caption>
              <thead>
                <tr>
                  <th scope="col">Pick</th>
                  <th scope="col">Round</th>
                  <th scope="col">Team</th>
                  <th scope="col">Player</th>
                  <th scope="col">Keeper</th>
                </tr>
              </thead>
              <tbody>
                {boardPicks.length === 0 && (
                  <tr>
                    <td colSpan={5}>No picks recorded yet.</td>
                  </tr>
                )}
                {[...boardPicks]
                  .sort((a, b) => a.overallPick - b.overallPick)
                  .map((pick) => (
                    <tr key={String(pick.overallPick)}>
                      <td>{label(pick.overallPick)}</td>
                      <td>{label(pick.round)}</td>
                      <td>
                        {initial.settingsSnapshot.teams.find((team) => team.slot === pick.teamSlot)
                          ?.displayName ?? label(pick.teamSlot)}
                        {pick.teamSlot === initial.settingsSnapshot.userDraftSlot ? " (you)" : ""}
                      </td>
                      <td>{pick.playerName}</td>
                      <td>{pick.isKeeper ? "Yes" : "—"}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </details>
      </section>

      <section
        id="dc-panel-players"
        tabIndex={-1}
        aria-label="Available players"
        className={panelHidden("players") ? "dc-tab-hidden" : ""}
      >
        <label className="dc-field">
          <span>Search players</span>
          <input
            ref={searchRef}
            type="search"
            placeholder="Press / to search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </label>
        <ul className="dc-pool-results" aria-label="Search results">
          {filtered.length === 0 && <li>No matching available players.</li>}
          {filtered.map((player, index) => (
            <li
              key={player.playerId}
              data-selected={
                activeTab === "players" && index === selectedPoolIndex ? "" : undefined
              }
            >
              <span className="dc-pool-player">
                {player.displayName}
                {player.positions.length > 0 && (
                  <small className="dc-pool-meta">
                    {" "}
                    {player.positions.join("/")}
                    {player.teamAbbreviation ? ` · ${player.teamAbbreviation}` : ""}
                  </small>
                )}
              </span>
              <button
                type="button"
                disabled={
                  readOnly ||
                  draftedIds.has(player.playerId) ||
                  optimisticIds.size > 0 ||
                  optimisticIds.has(player.playerId)
                }
                onClick={() => {
                  void makePickRequest(player.playerId);
                }}
              >
                {draftedIds.has(player.playerId) || optimisticIds.has(player.playerId)
                  ? "Drafted"
                  : "Draft"}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section
        id="dc-panel-roster"
        tabIndex={-1}
        aria-label="My roster"
        className={panelHidden("roster") ? "dc-tab-hidden" : ""}
      >
        <h2 id="dc-my-roster">My roster</h2>
        <ul>
          {(myTeam?.assignments.length ?? 0) === 0 && <li>No picks yet.</li>}
          {myTeam?.assignments.map((assignment) => (
            <li key={[assignment.playerId, label(assignment.sequence)].join("-")}>
              Pick #{label(assignment.sequence)} ·{" "}
              {assignment.playerName ?? playerNameById.get(assignment.playerId) ?? "Unknown player"}
              {assignment.isKeeper ? " (keeper)" : ""}
            </li>
          ))}
        </ul>
      </section>

      {rosterTeam !== undefined && (
        <Sheet isOpen onClose={closeRosterSheet} title={`${rosterTeam.displayName} roster`}>
          <ul className="dc-sheet-roster">
            {rosterTeam.assignments.length === 0 && <li>No picks yet.</li>}
            {rosterTeam.assignments.map((assignment) => (
              <li key={[String(rosterTeam.slot), assignment.playerId].join("-")}>
                Round {label(assignment.round ?? 0)} ·{" "}
                {assignment.playerName ??
                  playerNameById.get(assignment.playerId) ??
                  "Unknown player"}
                {assignment.isKeeper ? " (keeper)" : ""}
              </li>
            ))}
          </ul>
        </Sheet>
      )}
    </div>
  );
}
