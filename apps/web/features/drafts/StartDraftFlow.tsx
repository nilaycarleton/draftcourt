"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  MockPersonalityPicker,
  type CpuPersonalityOption,
} from "../../../../packages/ui/src/components/MockPersonalityPicker";
import { strategyPreview, type StrategySummaryView } from "@/features/preferences/strategyPreview";
import {
  readMockPacing,
  writeMockPacing,
  type MockPacingSettings,
  type MockPacingSpeed,
} from "./mockPacing";

/**
 * Pre-draft strategy flow for /drafts/new (Phase 3B). Pick a league, see the
 * resolved-strategy preview the server WOULD capture at start (precedence:
 * draft override → league selection → user default → DraftCourt defaults),
 * optionally override with a different owned profile, then create + start.
 * The override id flows into BOTH the preview query and the create body so
 * what you previewed is exactly what gets locked. Failures keep every choice
 * on screen — only the banner changes.
 *
 * Phase 3C adds an optional MOCK branch: draft-type radios reveal a CPU
 * personality picker, per-team overrides, an optional simulation seed and
 * pacing preferences (persisted via mockPacing for the room to inherit).
 * The REAL path's request bodies are byte-identical to the pre-3C flow.
 */

export interface StartDraftLeague {
  id: string;
  name: string;
  type: string;
  userDraftSlot: number;
  teamCount: number;
  strategySelection: {
    preferredProfileId: string | null;
    preferredProfileName: string | null;
    defaultProfileId: string | null;
    defaultProfileName: string | null;
  };
}

export interface StartDraftTeamOption {
  slot: number;
  displayName: string;
  isUserTeam: boolean;
}

interface StrategyPreviewPayload {
  kind: "USER_DEFAULT" | "LEAGUE_SELECTION" | "DRAFT_OVERRIDE" | "DRAFTCOURT_DEFAULTS";
  profileId: string | null;
  profileName: string | null;
  settingsSummary: StrategySummaryView;
}

export interface PickerProfileOption {
  id: string;
  name: string;
  isDefault: boolean;
}

const KIND_LABELS: Record<StrategyPreviewPayload["kind"], string> = {
  USER_DEFAULT: "Your default profile",
  LEAGUE_SELECTION: "League selection",
  DRAFT_OVERRIDE: "Draft override",
  DRAFTCOURT_DEFAULTS: "DraftCourt defaults",
};

async function api<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined ? { body: init.body } : {}),
    headers: { "Content-Type": "application/json" },
  });
  const body = (await response.json().catch(() => null)) as {
    data?: T;
    error?: { detail?: string };
  } | null;
  if (!response.ok || body === null) {
    throw new Error(body?.error?.detail ?? "Request failed.");
  }
  return body.data as T;
}

function previewUrl(leagueId: string, overrideProfileId: string | null): string {
  const base = `/api/v1/leagues/${leagueId}/strategy-preview`;
  return overrideProfileId === null
    ? base
    : `${base}?overrideProfileId=${encodeURIComponent(overrideProfileId)}`;
}

/** Published create-body constraint for the optional simulation seed. */
const SIMULATION_SEED_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

const SPEED_RADIO_LABELS: Record<MockPacingSpeed, string> = {
  SLOW: "Slow",
  NORMAL: "Normal",
  INSTANT: "Instant",
};

export function StartDraftFlow({
  leagues,
  personalities = [],
  teams = [],
}: {
  leagues: StartDraftLeague[];
  /** CPU personality catalog as plain props; empty pre-wiring degrades to
   * the "Follow default" option only. */
  personalities?: CpuPersonalityOption[] | undefined;
  /** League team list for the advanced per-team personality overrides. */
  teams?: StartDraftTeamOption[] | undefined;
}): React.JSX.Element {
  const router = useRouter();
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [overrideMode, setOverrideMode] = useState<"league" | "profile">("league");
  const [overrideProfileId, setOverrideProfileId] = useState<string>("");
  const [profiles, setProfiles] = useState<PickerProfileOption[] | null>(null);
  const [storedPreview, setStoredPreview] = useState<{
    forKey: string;
    data: StrategyPreviewPayload | null;
  } | null>(null);
  const [starting, setStarting] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const profilesLoadedFor = useRef(false);

  // Phase 3C mock state. `undefined` cpuPersonalityKey means "unset" so the
  // first catalog option is the default selection while an explicit
  // "Follow default" (null) stays respected.
  const [draftType, setDraftType] = useState<"REAL" | "MOCK">("REAL");
  const [cpuPersonalityKey, setCpuPersonalityKey] = useState<string | null | undefined>(undefined);
  const [teamOverrides, setTeamOverrides] = useState<Record<number, string>>({});
  const [simulationSeed, setSimulationSeed] = useState<string>("");
  const [seedError, setSeedError] = useState<string | null>(null);
  const [pacing, setPacing] = useState<MockPacingSettings>(() => readMockPacing());

  const selectedLeague = leagues.find((league) => league.id === leagueId) ?? null;
  const effectiveOverrideId =
    overrideMode === "profile" && overrideProfileId !== "" ? overrideProfileId : null;
  const resolvedPersonalityKey =
    cpuPersonalityKey === undefined ? (personalities[0]?.key ?? null) : cpuPersonalityKey;
  const nonUserTeams = teams.filter((team) => !team.isUserTeam);

  // Preview is keyed by its exact request URL: whenever the league or
  // effective override changes, the stored result no longer matches the key
  // and the UI derives a loading state — no synchronous effect setState.
  useEffect(() => {
    if (leagueId === null) return undefined;
    let cancelled = false;
    const requestKey = previewUrl(leagueId, effectiveOverrideId);
    api<StrategyPreviewPayload>(requestKey)
      .then((data) => {
        if (!cancelled) setStoredPreview({ forKey: requestKey, data });
      })
      .catch(() => {
        if (!cancelled) setStoredPreview({ forKey: requestKey, data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveOverrideId, leagueId]);

  const currentPreviewUrl = leagueId === null ? null : previewUrl(leagueId, effectiveOverrideId);
  const preview =
    storedPreview !== null && storedPreview.forKey === currentPreviewUrl ? storedPreview : null;
  const previewLoading = currentPreviewUrl !== null && preview === null;
  const shownPreview = preview?.data ?? null;

  // Profile options load once, lazily, when the override picker is opened.
  useEffect(() => {
    if (overrideMode !== "profile" || profilesLoadedFor.current) return undefined;
    profilesLoadedFor.current = true;
    let cancelled = false;
    api<{ profiles: PickerProfileOption[] }>("/api/v1/preference-profiles")
      .then((data) => {
        if (!cancelled) setProfiles(data.profiles);
      })
      .catch(() => {
        if (!cancelled) setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [overrideMode]);

  const updatePacing = useCallback((next: MockPacingSettings): void => {
    setPacing(next);
    writeMockPacing(next);
  }, []);

  const trimmedSeed = simulationSeed.trim();
  const seedIsValid = trimmedSeed === "" || SIMULATION_SEED_PATTERN.test(trimmedSeed);

  const start = useCallback(async (): Promise<void> => {
    if (leagueId === null || starting) return;
    if (draftType === "MOCK") {
      const seedValue = simulationSeed.trim();
      if (seedValue !== "" && !SIMULATION_SEED_PATTERN.test(seedValue)) {
        setSeedError("Use letters, numbers and dashes only (up to 64 characters).");
        return;
      }
    }
    setStarting(true);
    setErrorDetail(null);
    try {
      // REAL keeps the exact pre-3C body; MOCK appends its optional fields.
      const mockFields =
        draftType === "MOCK"
          ? {
              type: "MOCK",
              ...(resolvedPersonalityKey !== null
                ? { cpuPersonalityKey: resolvedPersonalityKey }
                : {}),
              ...(Object.keys(teamOverrides).length > 0
                ? {
                    teamPersonalities: Object.entries(teamOverrides).map(
                      ([teamSlot, personalityKey]) => ({
                        teamSlot: Number(teamSlot),
                        personalityKey,
                      }),
                    ),
                  }
                : {}),
              ...(simulationSeed.trim() !== "" ? { simulationSeed: simulationSeed.trim() } : {}),
            }
          : {};
      const created = await api<{ id: string }>("/api/v1/drafts", {
        method: "POST",
        body: JSON.stringify({
          leagueId,
          ...(effectiveOverrideId !== null ? { overrideProfileId: effectiveOverrideId } : {}),
          ...mockFields,
        }),
      });
      await api<{ status: string; version: number }>(`/api/v1/drafts/${created.id}/start`, {
        method: "POST",
      });
      router.push(`/drafts/${created.id}`);
    } catch (cause) {
      setErrorDetail(cause instanceof Error ? cause.message : "Starting failed — try again.");
    } finally {
      setStarting(false);
    }
  }, [
    draftType,
    effectiveOverrideId,
    leagueId,
    resolvedPersonalityKey,
    router,
    simulationSeed,
    starting,
    teamOverrides,
  ]);

  return (
    <div className="dc-start-flow">
      <div aria-live="polite" className="dc-visually-hidden" role="status">
        {starting ? "Starting draft…" : ""}
      </div>

      {errorDetail !== null && (
        <div role="alert" className="dc-strategy-banner">
          <span>Could not start: {errorDetail}</span>
          <button type="button" disabled={starting} onClick={() => void start()}>
            Retry
          </button>
        </div>
      )}

      <fieldset className="dc-start-league-fieldset">
        <legend>
          <h2>League</h2>
        </legend>
        {leagues.map((league) => (
          <label key={league.id} className="dc-strategy-option">
            <input
              type="radio"
              name="dc-start-league"
              value={league.id}
              checked={leagueId === league.id}
              onChange={() => {
                setLeagueId(league.id);
                setStoredPreview(null);
                setErrorDetail(null);
              }}
            />
            <span className="dc-strategy-option-name" title={league.name}>
              {league.name}
            </span>
            <small className="dc-strategy-meta">
              {league.type} · slot {String(league.userDraftSlot)} of {String(league.teamCount)}
            </small>
          </label>
        ))}
      </fieldset>

      <fieldset className="dc-start-type-fieldset">
        <legend>
          <h2>Draft type</h2>
        </legend>
        <label className="dc-strategy-option">
          <input
            type="radio"
            name="dc-draft-type"
            checked={draftType === "REAL"}
            onChange={() => {
              setDraftType("REAL");
              setErrorDetail(null);
            }}
          />
          <span className="dc-strategy-option-name">Real draft</span>
          <small className="dc-strategy-meta">You make every pick yourself.</small>
        </label>
        <label className="dc-strategy-option">
          <input
            type="radio"
            name="dc-draft-type"
            checked={draftType === "MOCK"}
            onChange={() => {
              setDraftType("MOCK");
              setErrorDetail(null);
            }}
          />
          <span className="dc-strategy-option-name">Mock draft</span>
          <small className="dc-strategy-meta">
            CPU teams pick alongside you so you can practise risk-free.
          </small>
        </label>
      </fieldset>

      <fieldset className="dc-start-override-fieldset" disabled={leagueId === null}>
        <legend>
          <h2>Strategy</h2>
        </legend>
        <p aria-live="polite" className="dc-preview-sentence">
          {selectedLeague === null
            ? "Choose a league to preview its resolved strategy."
            : previewLoading
              ? "Loading strategy preview…"
              : shownPreview === null
                ? "Strategy preview unavailable."
                : `${KIND_LABELS[shownPreview.kind]}${shownPreview.profileName === null ? "" : ` “${shownPreview.profileName}”`}: ${strategyPreview(shownPreview.settingsSummary)}`}
        </p>

        <label className="dc-strategy-option">
          <input
            type="radio"
            name="dc-override-mode"
            checked={overrideMode === "league"}
            onChange={() => {
              setOverrideMode("league");
              setStoredPreview(null);
              setErrorDetail(null);
            }}
          />
          <span className="dc-strategy-option-name">Follow league selection</span>
          <small className="dc-strategy-meta">
            {selectedLeague === null
              ? ""
              : (selectedLeague.strategySelection.preferredProfileName ??
                selectedLeague.strategySelection.defaultProfileName ??
                "No default set")}
          </small>
        </label>
        <label className="dc-strategy-option">
          <input
            type="radio"
            name="dc-override-mode"
            checked={overrideMode === "profile"}
            onChange={() => {
              setOverrideMode("profile");
              setStoredPreview(null);
              setErrorDetail(null);
            }}
          />
          <span className="dc-strategy-option-name">Pick a different profile…</span>
        </label>

        {overrideMode === "profile" && (
          <div className="dc-field dc-start-profile-select">
            <label htmlFor="dc-override-profile">Override profile</label>
            <select
              id="dc-override-profile"
              value={overrideProfileId}
              onChange={(event) => {
                setOverrideProfileId(event.target.value);
                setStoredPreview(null);
                setErrorDetail(null);
              }}
            >
              <option value="">Select a profile…</option>
              {(profiles ?? []).map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                  {profile.isDefault ? " ★" : ""}
                </option>
              ))}
            </select>
          </div>
        )}
      </fieldset>

      {draftType === "MOCK" && (
        <section className="dc-mock-setup" aria-label="Mock draft setup">
          <h2>Mock draft setup</h2>

          {personalities.length === 0 ? (
            <p className="dc-mock-setup-hint">
              CPU personalities are unavailable right now — every CPU team will follow the league
              default.
            </p>
          ) : (
            <MockPersonalityPicker
              personalities={personalities}
              value={resolvedPersonalityKey}
              onChange={(key) => {
                setCpuPersonalityKey(key);
                setErrorDetail(null);
              }}
            />
          )}

          <details className="dc-mock-advanced">
            <summary>Advanced: per-team personalities</summary>
            {nonUserTeams.length === 0 ? (
              <p className="dc-mock-setup-hint">
                Team list unavailable — all CPU teams will use the default personality.
              </p>
            ) : (
              nonUserTeams.map((team) => (
                <div key={team.slot} className="dc-mock-team-row">
                  <label htmlFor={`dc-mock-team-${String(team.slot)}`} title={team.displayName}>
                    {team.displayName}
                  </label>
                  <select
                    id={`dc-mock-team-${String(team.slot)}`}
                    value={teamOverrides[team.slot] ?? ""}
                    onChange={(event) => {
                      const personality = event.target.value;
                      setTeamOverrides((previous) => {
                        if (personality === "") {
                          return Object.fromEntries(
                            Object.entries(previous).filter(([slot]) => Number(slot) !== team.slot),
                          );
                        }
                        return { ...previous, [team.slot]: personality };
                      });
                      setErrorDetail(null);
                    }}
                  >
                    <option value="">Follow league default</option>
                    {personalities.map((personality) => (
                      <option key={personality.key} value={personality.key}>
                        {personality.title}
                      </option>
                    ))}
                  </select>
                </div>
              ))
            )}
          </details>

          <div className="dc-field dc-mock-seed-field">
            <label htmlFor="dc-mock-seed">Simulation seed (optional)</label>
            <input
              id="dc-mock-seed"
              type="text"
              value={simulationSeed}
              maxLength={64}
              aria-invalid={seedError !== null || !seedIsValid || undefined}
              aria-describedby={seedError !== null ? "dc-mock-seed-error" : "dc-mock-seed-hint"}
              onChange={(event) => {
                setSimulationSeed(event.target.value);
                setSeedError(null);
              }}
            />
            {seedError !== null ? (
              <p id="dc-mock-seed-error" className="dc-mock-seed-error">
                {seedError}
              </p>
            ) : (
              <p id="dc-mock-seed-hint" className="dc-mock-setup-hint">
                Same seed and same settings replay the same CPU draft.
              </p>
            )}
          </div>

          <fieldset className="dc-mock-pacing-fieldset">
            <legend>Pacing</legend>
            {(["SLOW", "NORMAL", "INSTANT"] as MockPacingSpeed[]).map((speedKey) => (
              <label key={speedKey} className="dc-strategy-option">
                <input
                  type="radio"
                  name="dc-mock-speed"
                  checked={pacing.speed === speedKey}
                  onChange={() => {
                    updatePacing({ ...pacing, speed: speedKey });
                  }}
                />
                <span className="dc-strategy-option-name">{SPEED_RADIO_LABELS[speedKey]}</span>
              </label>
            ))}
            <button
              type="button"
              role="switch"
              aria-checked={pacing.autoAdvance}
              className="dc-mock-switch"
              onClick={() => {
                updatePacing({ ...pacing, autoAdvance: !pacing.autoAdvance });
              }}
            >
              <span
                aria-hidden="true"
                className="dc-mock-switch-track"
                data-on={pacing.autoAdvance || undefined}
              />
              <span className="dc-mock-switch-label">Auto-advance</span>
            </button>
            <small className="dc-strategy-meta">Saved for your next mock draft.</small>
          </fieldset>
        </section>
      )}

      <p className="dc-strategy-save-row">
        <button
          type="button"
          className="dc-button-primary"
          disabled={leagueId === null || starting}
          onClick={() => void start()}
        >
          {starting ? "Starting…" : "Start draft"}
        </button>
      </p>
    </div>
  );
}
