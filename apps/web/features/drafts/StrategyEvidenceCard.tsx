"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { Sheet } from "@draftcourt/ui";

/**
 * Draft-room strategy evidence (Phase 3B): a quiet provenance strip between
 * the conflict banner and the tabs — visible on every tab, visually quieter
 * than recommendations. The Details sheet reveals the immutable snapshot the
 * engine actually ran on: factor weights, punts, avoid behavior, influence
 * counts, versions/checksum, and an explicit "cannot be edited" sentence with
 * a link to /preferences for FUTURE drafts. Absent strategy renders nothing;
 * INVALID degrades honestly to a warning strip.
 */

export interface DraftRoomStrategyEvidence {
  status: "OK" | "INVALID";
  source: {
    kind: string;
    profileId: string | null;
    profileName: string | null;
    presetKey: string | null;
    presetVersion: number | null;
  };
  snapshotVersion: number | null;
  preferenceSchemaVersion: number | null;
  checksum: string | null;
  capturedAt: string | null;
  engineVersion: string;
  settingsSummary: {
    topFactors: { key: string; weight: number }[];
    punts: string[];
    avoidMode: "EXCLUDE" | "SEVERE_PENALTY";
    scheduleEnabled: boolean;
    favoritePlayers: number;
    dislikedPlayers: number;
    targetPlayers: number;
    avoidedPlayers: number;
    teamPreferences: number;
    customRanks: number;
  } | null;
}

const PROVENANCE_LABELS: Record<string, string> = {
  USER_DEFAULT: "User default",
  LEAGUE_SELECTION: "League selection",
  DRAFT_OVERRIDE: "Draft override",
  DRAFTCOURT_DEFAULTS: "DraftCourt defaults",
};

const FACTOR_LABELS: Record<string, string> = {
  production: "Projected production",
  scarcity: "Positional scarcity",
  rosterNeed: "Roster need",
  risk: "Injury risk safety",
  consistency: "Consistency",
  age: "Age curve",
  adpValue: "ADP value",
  upside: "Upside",
  role: "Role / minutes",
  nextPickAvailability: "Next-pick availability",
  preference: "Personal preference",
};

function factorLabel(key: string): string {
  return FACTOR_LABELS[key] ?? key;
}

function shortChecksum(checksum: string): string {
  return checksum.slice(0, 10);
}

function capturedDate(capturedAt: string): string {
  return capturedAt.slice(0, 10);
}

export function StrategyEvidenceCard({
  strategy,
}: {
  strategy: DraftRoomStrategyEvidence | undefined | null;
}): React.JSX.Element | null {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsInvokerRef = useRef<HTMLButtonElement | null>(null);

  const openDetails = useCallback((): void => {
    detailsInvokerRef.current =
      document.activeElement instanceof HTMLElement
        ? (document.activeElement as HTMLButtonElement)
        : null;
    setDetailsOpen(true);
  }, []);

  const closeDetails = useCallback((): void => {
    setDetailsOpen(false);
    detailsInvokerRef.current?.focus();
    detailsInvokerRef.current = null;
  }, []);

  if (strategy === undefined || strategy === null) return null;

  if (strategy.status === "INVALID") {
    return (
      <div role="status" className="dc-evidence-card dc-evidence-invalid">
        <span>Stored strategy snapshot could not be read.</span>
      </div>
    );
  }

  const provenance = PROVENANCE_LABELS[strategy.source.kind] ?? strategy.source.kind;
  const summary = strategy.settingsSummary;

  return (
    <div className="dc-evidence-card">
      <span className="dc-evidence-badge" data-kind={strategy.source.kind}>
        {provenance}
      </span>
      {strategy.source.profileName !== null && (
        <span className="dc-evidence-name" title={strategy.source.profileName}>
          {strategy.source.profileName}
        </span>
      )}
      <span className="dc-evidence-locked">Locked at draft start</span>
      <button type="button" className="dc-mini-button" onClick={openDetails}>
        Details
      </button>

      {detailsOpen && (
        <Sheet isOpen onClose={closeDetails} title="Draft strategy evidence">
          <div className="dc-evidence-sheet">
            {summary !== null && (
              <>
                <table className="dc-evidence-table">
                  <caption>Factor weights captured at draft start</caption>
                  <thead>
                    <tr>
                      <th scope="col">Factor</th>
                      <th scope="col">Weight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.topFactors.map((factor) => (
                      <tr key={factor.key}>
                        <td>{factorLabel(factor.key)}</td>
                        <td className="dc-factor-value">{factor.weight.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {summary.punts.length > 0 ? (
                  <div>
                    Punted categories:
                    <ul className="dc-evidence-punts">
                      {summary.punts.map((stat) => (
                        <li key={stat}>{stat}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p>No punted categories.</p>
                )}

                <p>
                  Avoided players:{" "}
                  {summary.avoidMode === "EXCLUDE" ? "Excluded entirely" : "Severe penalty"}
                </p>

                <table className="dc-evidence-table">
                  <caption>Personal influences applied</caption>
                  <tbody>
                    <tr>
                      <th scope="row">Favorite players</th>
                      <td className="dc-factor-value">{String(summary.favoritePlayers)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Target players</th>
                      <td className="dc-factor-value">{String(summary.targetPlayers)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Disliked players</th>
                      <td className="dc-factor-value">{String(summary.dislikedPlayers)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Avoided players</th>
                      <td className="dc-factor-value">{String(summary.avoidedPlayers)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Team preferences</th>
                      <td className="dc-factor-value">{String(summary.teamPreferences)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Custom ranks</th>
                      <td className="dc-factor-value">{String(summary.customRanks)}</td>
                    </tr>
                  </tbody>
                </table>
              </>
            )}

            <table className="dc-evidence-table">
              <caption>Snapshot provenance</caption>
              <tbody>
                <tr>
                  <th scope="row">Engine version</th>
                  <td>{strategy.engineVersion}</td>
                </tr>
                {strategy.snapshotVersion !== null && (
                  <tr>
                    <th scope="row">Snapshot version</th>
                    <td className="dc-factor-value">{String(strategy.snapshotVersion)}</td>
                  </tr>
                )}
                {strategy.checksum !== null && (
                  <tr>
                    <th scope="row">Checksum</th>
                    <td className="dc-factor-value" title={strategy.checksum}>
                      {shortChecksum(strategy.checksum)}
                    </td>
                  </tr>
                )}
                {strategy.capturedAt !== null && (
                  <tr>
                    <th scope="row">Captured</th>
                    <td>{capturedDate(strategy.capturedAt)}</td>
                  </tr>
                )}
              </tbody>
            </table>

            <p>
              <Link href="/preferences">Edit for future drafts</Link>
            </p>
            <p className="dc-hint">This draft&rsquo;s strategy cannot be edited.</p>
          </div>
        </Sheet>
      )}
    </div>
  );
}
