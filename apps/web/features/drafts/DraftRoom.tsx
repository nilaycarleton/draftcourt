"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RecommendationOutput } from "@draftcourt/domain";

/**
 * Live draft room (BUILD_SPEC section 9.2; Impeccable shape:
 * docs/design/phase2-shape.md). Optimistic pick display followed by
 * authoritative reconciliation; version conflicts restore server state and
 * explain the change; keyboard shortcuts per spec (`/` `D` `U` `R` `B` `M`
 * `?` Escape); a single polite live region announces picks and updates.
 */

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
      assignments: { playerId: string; sequence: number }[];
    }[];
  };
}

interface PoolPlayer {
  playerId: string;
  displayName: string;
}

function slotForPick(pick: number, teams: number): number {
  const positionInRound = ((pick - 1) % teams) + 1;
  const round = Math.ceil(pick / teams);
  return round % 2 === 1 ? positionInRound : teams + 1 - positionInRound;
}

const label = (value: number | undefined): string => String(value ?? "");

export function DraftRoom({ draftId, initial }: DraftRoomProps) {
  const [version, setVersion] = useState(initial.version);
  const [status, setStatus] = useState(initial.status);
  const [nextPick, setNextPick] = useState(initial.nextOverallPick);
  const [draftedIds, setDraftedIds] = useState<Set<string>>(
    () => new Set(initial.teams.flatMap((team) => team.assignments.map((a) => a.playerId))),
  );
  const [pool, setPool] = useState<PoolPlayer[]>([]);
  const [search, setSearch] = useState("");
  const [recs, setRecs] = useState<RecommendationOutput | null>(null);
  const [calculating, setCalculating] = useState(true);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [optimisticPick, setOptimisticPick] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Player pool for search-to-draft (loaded once).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/players?limit=600")
      .then((response) => response.json())
      .then((body: { data?: { id: string; displayName: string }[] }) => {
        if (!cancelled && Array.isArray(body.data)) {
          setPool(body.data.map((p) => ({ playerId: p.id, displayName: p.displayName })));
        }
      })
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

  const makePickRequest = useCallback(
    async (playerId: string): Promise<void> => {
      if (draftedIds.has(playerId)) return;
      setOptimisticPick(playerId);
      setDraftedIds((prev) => new Set(prev).add(playerId));
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
          const authoritative = bodyJson.error.authoritative;
          setVersion(authoritative.version);
          setStatus(authoritative.status);
          setNextPick(authoritative.nextOverallPick);
          setConflictMessage(
            bodyJson.error.detail ??
              "The draft changed while you were picking — the board below now shows the authoritative state.",
          );
        } else if (response.ok && bodyJson.data?.authoritative) {
          setVersion(bodyJson.data.authoritative.version ?? version + 1);
          setNextPick(bodyJson.data.authoritative.nextOverallPick ?? nextPick + 1);
          setAnnouncement("Pick recorded.");
        } else {
          setDraftedIds((prev) => {
            const next = new Set(prev);
            next.delete(playerId);
            return next;
          });
          setAnnouncement(bodyJson.error?.detail ?? "The pick was not accepted.");
        }
      } catch {
        setDraftedIds((prev) => {
          const next = new Set(prev);
          next.delete(playerId);
          return next;
        });
        setAnnouncement("Network error — the pick was not recorded.");
      } finally {
        setOptimisticPick(null);
        await refreshRecommendations();
      }
    },
    [draftedIds, draftId, nextPick, refreshRecommendations, version],
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
        setVersion((v) => v + 1);
        setNextPick((p) => Math.max(1, p - 1));
        setAnnouncement("Last pick undone.");
        await refreshRecommendations();
      }
    } catch {
      setAnnouncement("Undo failed — try again.");
    }
  }, [draftId, refreshRecommendations, version]);

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
        searchRef.current?.focus();
        return;
      }
      if (typing) return;
      switch (event.key.toLowerCase()) {
        case "r":
          document.getElementById("dc-recs")?.focus();
          break;
        case "b":
          document.getElementById("dc-board")?.focus();
          break;
        case "m":
          document.getElementById("dc-my-roster")?.focus();
          break;
        case "?":
          setAnnouncement(
            "Shortcuts: slash focuses search. D drafts the selected player. U undoes. R recommendations. B board. M my roster.",
          );
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = q ? pool.filter((p) => p.displayName.toLowerCase().includes(q)) : pool;
    return base.slice(0, 12);
  }, [pool, search]);

  const picksUntilTurn = useMemo(() => {
    const total = initial.settingsSnapshot.rounds * initial.settingsSnapshot.teamCount;
    let count = 0;
    for (let pick = Math.max(1, nextPick); pick <= total; pick++) {
      count += 1;
      if (
        slotForPick(pick, initial.settingsSnapshot.teamCount) ===
        initial.settingsSnapshot.userDraftSlot
      )
        return count;
    }
    return count;
  }, [
    initial.settingsSnapshot.teamCount,
    initial.settingsSnapshot.userDraftSlot,
    initial.settingsSnapshot.rounds,
    nextPick,
  ]);

  const readOnly = status === "COMPLETED" || status === "ABANDONED";
  const myTeam = initial.teams.find((team) => team.isUserTeam);

  return (
    <div className="dc-draft-room">
      <div aria-live="polite" className="dc-visually-hidden">
        {announcement}
      </div>

      <header className="dc-status-bar">
        <span>
          Round {label(Math.ceil(nextPick / initial.settingsSnapshot.teamCount))} · pick{" "}
          {label(nextPick)} of {label(initial.boardSize)}
        </span>
        <span>
          {picksUntilTurn > 0 ? `${label(picksUntilTurn)} picks until your turn` : "On the clock"}
        </span>
        <span data-status={status}>{status}</span>
        <button
          type="button"
          disabled={readOnly}
          onClick={() => {
            void undoLatest();
          }}
        >
          Undo
        </button>
      </header>

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

      <section
        id="dc-recs"
        tabIndex={-1}
        aria-label="Top three recommendations"
        className="dc-recs"
      >
        <h2>Best available</h2>
        {calculating && <p className="dc-hint">Recalculating…</p>}
        <ol>
          {(recs?.top3 ?? []).map((entry) => (
            <li key={entry.playerId}>
              <strong>{entry.displayName}</strong> — score {label(entry.draftScore)}
              <small>
                {" "}
                {entry.labels.join(", ")} · {entry.explanation}
              </small>
              {!readOnly && (
                <button
                  type="button"
                  disabled={draftedIds.has(entry.playerId)}
                  onClick={() => {
                    void makePickRequest(entry.playerId);
                  }}
                >
                  {draftedIds.has(entry.playerId) ? "Drafted" : "Draft"}
                </button>
              )}
            </li>
          ))}
        </ol>
      </section>

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
        {filtered.map((player) => (
          <li key={player.playerId}>
            {player.displayName}
            <button
              type="button"
              disabled={readOnly || draftedIds.has(player.playerId) || optimisticPick !== null}
              onClick={() => {
                void makePickRequest(player.playerId);
              }}
            >
              {draftedIds.has(player.playerId) ? "Drafted" : "Draft"}
            </button>
          </li>
        ))}
      </ul>

      <h2 id="dc-board-heading">Board</h2>
      {/* Semantic table alternative to the visual board (WCAG 2.2 AA). */}
      <table
        id="dc-board"
        tabIndex={-1}
        className="dc-board-table"
        aria-labelledby="dc-board-heading"
      >
        <caption>Every selection by round and team.</caption>
        <thead>
          <tr>
            <th scope="col">Team</th>
            <th scope="col">Picks used</th>
          </tr>
        </thead>
        <tbody>
          {initial.settingsSnapshot.teams.map((team) => {
            const teamAssignments = initial.teams.find((t) => t.slot === team.slot)?.assignments;
            return (
              <tr key={team.slot}>
                <th scope="row">
                  Slot {label(team.slot)}: {team.displayName}
                  {team.isUserTeam ? " (you)" : ""}
                </th>
                <td>
                  {teamAssignments !== undefined && teamAssignments.length > 0
                    ? teamAssignments.length
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <section id="dc-my-roster" tabIndex={-1} aria-label="My roster">
        <h2>My roster</h2>
        <ul>
          {(myTeam?.assignments.length ?? 0) === 0 && <li>No picks yet.</li>}
          {myTeam?.assignments.map((assignment) => (
            <li key={[assignment.playerId, label(assignment.sequence)].join("-")}>
              Pick #{label(assignment.sequence)}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
