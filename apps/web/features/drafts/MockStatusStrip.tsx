"use client";

import { useCallback, useState } from "react";

/**
 * Mock-draft status strip (Phase 3C): simulation seed with copy affordance,
 * a one-line personality summary, and an optional completed summary variant.
 * Purely presentational; the room passes the `mock` slice of its data.
 */

export interface MockStatusStripTeam {
  slot: number;
  displayName: string;
  isUserTeam: boolean;
  personalityKey: string | null;
}

export interface MockStatusStripProps {
  simSeed: string | null;
  teams: MockStatusStripTeam[];
  completedSummary?: { totalPicks: number; userPicks: number } | undefined;
}

export function MockStatusStrip({
  simSeed,
  teams,
  completedSummary,
}: MockStatusStripProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const copySeed = useCallback(() => {
    if (simSeed === null) return;
    if (!("clipboard" in navigator)) return;
    navigator.clipboard
      .writeText(simSeed)
      .then(() => {
        setCopied(true);
      })
      .catch(() => {
        setCopied(false);
      });
  }, [simSeed]);

  const customTeams = teams.filter((team) => team.personalityKey !== null && !team.isUserTeam);

  return (
    <div
      className="dc-mock-status-strip"
      data-completed={completedSummary !== undefined || undefined}
    >
      <span className="dc-mock-status-label">Mock draft</span>

      {simSeed !== null && (
        <span className="dc-mock-seed-group">
          <span className="dc-mock-status-label">Seed</span>
          <code className="dc-mock-seed" title={simSeed}>
            {simSeed}
          </code>
          <button
            type="button"
            className="dc-mock-copy-button"
            aria-label="Copy simulation seed"
            onClick={copySeed}
          >
            Copy
          </button>
          {copied && (
            <span role="status" className="dc-visually-hidden">
              Simulation seed copied.
            </span>
          )}
        </span>
      )}

      <span
        className="dc-mock-personality-summary"
        title={teams.map((t) => t.displayName).join(", ")}
      >
        {customTeams.length === 0
          ? "All CPU teams follow the league default"
          : `${String(customTeams.length)} of ${String(teams.length - (teams.some((t) => t.isUserTeam) ? 1 : 0))} CPU teams use custom personalities`}
      </span>

      {completedSummary !== undefined && (
        <span className="dc-mock-completed-summary">
          Completed · {String(completedSummary.totalPicks)} picks ·{" "}
          {String(completedSummary.userPicks)} yours
        </span>
      )}
    </div>
  );
}
