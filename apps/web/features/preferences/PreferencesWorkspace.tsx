"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FactorSliderRow, PresetGallery, RankListEditor } from "@draftcourt/ui";
import {
  applyPreset,
  defaultFactorPriority,
  defaultPreferenceSettings,
  getPreset,
  normalizeFactorWeights,
  preferencePresets,
  validatePuntConsistency,
  PreferenceNormalizationError,
  type PreferenceFactorKey,
  type PreferenceSettings,
} from "@draftcourt/domain";
import { strategyPreview } from "./strategyPreview";

/**
 * Authenticated `/preferences` workspace (Phase 3A). Composition layer over
 * `@draftcourt/ui` primitives and the domain package — presets apply through
 * the SAME domain definitions the API validates, so there is no duplicated
 * preset logic in the UI. Saved preferences affect FUTURE drafts only; this
 * surface never claims an active draft was updated (Phase 3B owns snapshots).
 */

// ---------------------------------------------------------------------------
// Types + tiny envelope-aware fetch helpers
// ---------------------------------------------------------------------------

/** Sentinel id for the not-yet-created profile draft. */
const NEW_PROFILE_ID = "__new__";

interface ProfileListItem {
  id: string;
  name: string;
  presetKey: string | null;
  presetVersion: number | null;
  schemaVersion: number;
  isDefault: boolean;
  updatedAt: string;
}

interface PreferenceEntry {
  playerId?: string;
  teamId?: string;
  listType: string;
  magnitude: number;
}

interface ProfileDetail extends ProfileListItem {
  settings: PreferenceSettings;
  playerPreferences: Required<Pick<PreferenceEntry, "playerId" | "listType" | "magnitude">>[];
  teamPreferences: Required<Pick<PreferenceEntry, "teamId" | "listType" | "magnitude">>[];
}

class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly errors?: Record<string, string[]>,
  ) {
    super(message);
  }
}

async function api<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined ? { body: init.body } : {}),
    ...(init?.signal !== undefined ? { signal: init.signal } : {}),
    headers: { "Content-Type": "application/json" },
  });
  const body = (await response.json().catch(() => null)) as {
    data?: T;
    error?: { detail?: string; status?: number; errors?: Record<string, string[]> };
  } | null;
  if (!response.ok || body === null) {
    throw new ApiError(
      body?.error?.detail ?? "Request failed.",
      response.status,
      body?.error?.errors,
    );
  }
  return body.data as T;
}

const FACTOR_LABELS: Record<PreferenceFactorKey, string> = {
  production: "Projected production",
  scarcity: "Positional scarcity",
  rosterNeed: "Roster need",
  risk: "Injury risk safety",
  consistency: "Consistency",
  age: "Age curve",
  adpValue: "ADP value",
  upside: "Upside",
  role: "Role / minutes",
  nextPickAvailability: "Survives to next pick",
  preference: "Personal preference",
};

const CATEGORY_STATS = [
  "PTS",
  "REB",
  "AST",
  "STL",
  "BLK",
  "TOV",
  "THREE_PM",
  "FGM",
  "FTM",
] as const;

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export function PreferencesWorkspace(): React.JSX.Element {
  const [profiles, setProfiles] = useState<ProfileListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saved, setSaved] = useState<ProfileDetail | null>(null);
  const [draft, setDraft] = useState<ProfileDetail | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ tone: "info" | "error"; message: string } | null>(null);
  const [pendingSwitchId, setPendingSwitchId] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  // Custom-rank state.
  const [leagues, setLeagues] = useState<{ id: string; name: string }[]>([]);
  const [rankScope, setRankScope] = useState<string>("global");
  const [rankItems, setRankItems] = useState<
    { playerId: string; displayName: string; tier?: number | null }[]
  >([]);
  const [rankNotes, setRankNotes] = useState<Record<string, string>>({});
  const [rankSavedSnapshot, setRankSavedSnapshot] = useState("");
  const [rankSaving, setRankSaving] = useState(false);
  const rankLoadedFor = useRef<string | null>(null);

  // Search state.
  const [playerQuery, setPlayerQuery] = useState("");
  const [playerResults, setPlayerResults] = useState<{ id: string; displayName: string }[]>([]);
  const [teamQuery, setTeamQuery] = useState("");
  const [teamResults, setTeamResults] = useState<
    { id: string; name: string; city: string; abbreviation: string }[]
  >([]);

  const dirty =
    saved !== null &&
    draft !== null &&
    JSON.stringify([
      draft.name,
      draft.isDefault,
      draft.presetKey,
      draft.settings,
      draft.playerPreferences,
      draft.teamPreferences,
    ]) !==
      JSON.stringify([
        saved.name,
        saved.isDefault,
        saved.presetKey,
        saved.settings,
        saved.playerPreferences,
        saved.teamPreferences,
      ]);
  const ranksDirty = JSON.stringify(rankItems.map((item) => [item.playerId])) !== rankSavedSnapshot;

  const announce = useCallback((tone: "info" | "error", message: string) => {
    setBanner({ tone, message });
  }, []);

  const loadList = useCallback(async (): Promise<void> => {
    setLoadingList(true);
    try {
      const data = await api<{ profiles: ProfileListItem[] }>("/api/v1/preference-profiles");
      setProfiles(data.profiles);
    } catch (error) {
      announce("error", error instanceof Error ? error.message : "Could not load profiles.");
    } finally {
      setLoadingList(false);
    }
  }, [announce]);

  const loadDetail = useCallback(async (id: string): Promise<void> => {
    setLoadingDetail(true);
    try {
      const data = await api<ProfileDetail>(`/api/v1/preference-profiles/${id}`);
      setSaved(data);
      setDraft(structuredClone(data));
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const bootstrapped = useRef(false);
  useEffect(() => {
    void (async () => {
      const data = await api<{ profiles: ProfileListItem[] }>("/api/v1/preference-profiles");
      setProfiles(data.profiles);
      setLoadingList(false);
      if (!bootstrapped.current) {
        bootstrapped.current = true;
        const first = data.profiles[0];
        if (first !== undefined) {
          setSelectedId(first.id);
          await loadDetail(first.id);
        }
      }
    })();
    void (async () => {
      try {
        const data = await api<{ id: string; name: string }[]>("/api/v1/leagues");
        setLeagues(data);
      } catch {
        setLeagues([]);
      }
    })();
  }, [loadDetail, loadList]);

  const selectProfile = useCallback(
    async (id: string): Promise<void> => {
      if (dirty) {
        setPendingSwitchId(id);
        return;
      }
      setDeleteArmed(false);
      if (id === NEW_PROFILE_ID) {
        setSelectedId(null);
        setSaved(null);
        setDraft({
          id: "",
          name: "",
          presetKey: null,
          presetVersion: null,
          schemaVersion: 1,
          isDefault: false,
          updatedAt: new Date().toISOString(),
          settings: defaultPreferenceSettings(),
          playerPreferences: [],
          teamPreferences: [],
        });
        return;
      }
      setSelectedId(id);
      await loadDetail(id);
    },
    [dirty, loadDetail],
  );

  // Unsaved-changes browser guard.
  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => {
      window.removeEventListener("beforeunload", handler);
    };
  }, [dirty]);

  const mutateSettings = useCallback(
    (mutator: (settings: PreferenceSettings) => PreferenceSettings) => {
      setDraft((previous) => {
        if (previous === null) return previous;
        const nextSettings = mutator(previous.settings);
        return { ...previous, presetKey: null, presetVersion: null, settings: nextSettings };
      });
    },
    [],
  );

  /** Moving a slider pins THAT factor at the dragged value; unlocked others
   * absorb the change proportionally. Near-saturation the value clamps to
   * the largest legal amount instead of throwing mid-drag. */
  const onFactorChange = useCallback(
    (key: PreferenceFactorKey, requested: number) => {
      mutateSettings((settings) => {
        const pinnedLocks = [...new Set([...settings.lockedFactors, key])];
        const attempt = (value: number): PreferenceSettings["factorWeights"] =>
          normalizeFactorWeights({ ...settings.factorWeights, [key]: value }, pinnedLocks).weights;
        try {
          return { ...settings, factorWeights: attempt(requested) };
        } catch (error) {
          if (!(error instanceof PreferenceNormalizationError)) throw error;
          const otherLockedTotal = settings.lockedFactors
            .filter((candidate) => candidate !== key)
            .reduce((sum, candidate) => sum + settings.factorWeights[candidate], 0);
          const clamped = Math.max(0, Math.min(requested, 1 - otherLockedTotal));
          return { ...settings, factorWeights: attempt(clamped) };
        }
      });
    },
    [mutateSettings],
  );

  const onToggleLock = useCallback(
    (key: PreferenceFactorKey) => {
      mutateSettings((settings) => {
        const lockedFactors = settings.lockedFactors.includes(key)
          ? settings.lockedFactors.filter((candidate) => candidate !== key)
          : [...settings.lockedFactors, key];
        return {
          ...settings,
          lockedFactors,
          factorWeights: normalizeFactorWeights(settings.factorWeights, lockedFactors).weights,
        };
      });
    },
    [mutateSettings],
  );

  const applyPresetByKey = useCallback(
    (key: string) => {
      const preset = getPreset(key);
      if (!preset || draft === null) return;
      const nextSettings = applyPreset(preset, draft.settings);
      setDraft({
        ...draft,
        presetKey: preset.key,
        presetVersion: preset.version,
        settings: nextSettings,
      });
      announce("info", `${preset.title} preset applied — values are editable.`);
    },
    [announce, draft],
  );

  const save = useCallback(async (): Promise<void> => {
    if (draft === null || saving) return;
    const puntProblem = validatePuntConsistency(draft.settings);
    if (puntProblem) {
      announce("error", puntProblem);
      return;
    }
    setSaving(true);
    try {
      if (draft.id === "") {
        const name = draft.name.trim();
        if (!name) {
          announce("error", "Give the profile a name before saving.");
          return;
        }
        const created = await api<ProfileDetail>("/api/v1/preference-profiles", {
          method: "POST",
          body: JSON.stringify({
            name,
            isDefault: profiles.length === 0 ? true : draft.isDefault,
            ...(draft.presetKey ? { preset: { key: draft.presetKey } } : {}),
            settings: draft.settings,
            playerPreferences: draft.playerPreferences,
            teamPreferences: draft.teamPreferences,
          }),
        });
        setSaved(created);
        setDraft(structuredClone(created));
        setSelectedId(created.id);
        announce("info", `Profile “${created.name}” created.`);
      } else {
        const updated = await api<ProfileDetail>(`/api/v1/preference-profiles/${draft.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: draft.name.trim(),
            isDefault: draft.isDefault,
            settings: draft.settings,
            playerPreferences: draft.playerPreferences,
            teamPreferences: draft.teamPreferences,
          }),
        });
        setSaved(updated);
        setDraft(structuredClone(updated));
        announce("info", "Preferences saved. They affect future drafts only.");
      }
      await loadList();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        announce("error", `${error.message} Reload the page to see other changes.`);
      } else if (error instanceof ApiError) {
        announce("error", error.message);
      } else {
        announce("error", "Saving failed — try again.");
      }
    } finally {
      setSaving(false);
    }
  }, [announce, draft, loadList, profiles.length, saving]);

  const duplicateProfile = useCallback(async (): Promise<void> => {
    if (saved === null || saving) return;
    setSaving(true);
    try {
      const created = await api<ProfileDetail>("/api/v1/preference-profiles", {
        method: "POST",
        body: JSON.stringify({
          name: `${saved.name} copy`,
          isDefault: false,
          settings: saved.settings,
          playerPreferences: saved.playerPreferences,
          teamPreferences: saved.teamPreferences,
        }),
      });
      setProfiles((previous) => [
        { ...created, playerPreferences: undefined } as unknown as ProfileListItem,
        ...previous,
      ]);
      announce("info", `Duplicated as “${created.name}”.`);
      await selectAfterReload(created.id);
    } catch (error) {
      announce("error", error instanceof ApiError ? error.message : "Duplicate failed.");
    } finally {
      setSaving(false);
    }

    async function selectAfterReload(id: string): Promise<void> {
      const list = await api<{ profiles: ProfileListItem[] }>("/api/v1/preference-profiles");
      setProfiles(list.profiles);
      setSelectedId(id);
      await loadDetail(id);
    }
  }, [announce, loadDetail, saving, saved]);

  const deleteSelected = useCallback(async (): Promise<void> => {
    if (saved === null || saving) return;
    setSaving(true);
    try {
      const result = await api<{ promotedDefaultName: string | null }>(
        `/api/v1/preference-profiles/${saved.id}`,
        { method: "DELETE" },
      );
      setDeleteArmed(false);
      announce(
        "info",
        result.promotedDefaultName
          ? `Deleted. “${result.promotedDefaultName}” is now your default profile.`
          : "Deleted.",
      );
      await loadList();
      const remaining = await api<{ profiles: ProfileListItem[] }>("/api/v1/preference-profiles");
      if (remaining.profiles[0]) {
        setSelectedId(remaining.profiles[0].id);
        await loadDetail(remaining.profiles[0].id);
      } else {
        setSelectedId(null);
        setSaved(null);
        setDraft(null);
      }
    } catch (error) {
      announce("error", error instanceof ApiError ? error.message : "Delete failed.");
    } finally {
      setSaving(false);
    }
  }, [announce, loadDetail, loadList, saving, saved]);

  // --- custom ranks ---------------------------------------------------------

  const loadRanks = useCallback(async (scope: string, leagueId: string | null): Promise<void> => {
    const query = leagueId === null ? "" : `?leagueId=${encodeURIComponent(leagueId)}`;
    const data = await api<{
      ranks: {
        playerId: string;
        displayName: string;
        rank: number;
        tier: number | null;
        note: string | null;
      }[];
    }>(`/api/v1/custom-ranks${query}`);
    setRankItems(data.ranks.map(({ playerId, displayName }) => ({ playerId, displayName })));
    const notes: Record<string, string> = {};
    for (const entry of data.ranks) {
      if (entry.note) notes[entry.playerId] = entry.note;
      notes[`${entry.playerId}:tier`] = entry.tier === null ? "" : String(entry.tier);
    }
    setRankNotes(notes);
    rankLoadedFor.current = scope;
    setRankSavedSnapshot(JSON.stringify(data.ranks.map(({ playerId }) => [playerId])));
  }, []);

  useEffect(() => {
    if (rankLoadedFor.current === rankScope) return;
    void loadRanks(rankScope, rankScope === "global" ? null : rankScope).catch(() => {
      announce("error", "Could not load your board.");
    });
  }, [announce, loadRanks, rankScope]);

  const moveRank = useCallback((playerId: string, direction: "up" | "down") => {
    setRankItems((previous) => {
      const index = previous.findIndex((item) => item.playerId === playerId);
      const target = direction === "up" ? index - 1 : index + 1;
      if (index < 0 || target < 0 || target >= previous.length) return previous;
      const next = [...previous];
      const removed = next.splice(index, 1);
      if (removed[0] === undefined) return previous;
      next.splice(target, 0, removed[0]);
      return next;
    });
  }, []);

  const saveRanks = useCallback(async (): Promise<void> => {
    if (rankSaving) return;
    setRankSaving(true);
    try {
      await api("/api/v1/custom-ranks", {
        method: "PUT",
        body: JSON.stringify({
          leagueId: rankScope === "global" ? null : rankScope,
          ranks: rankItems.map((item, index) => ({
            playerId: item.playerId,
            rank: index + 1,
            tier: rankNotes[`${item.playerId}:tier`]
              ? Number(rankNotes[`${item.playerId}:tier`])
              : null,
            note:
              rankNotes[item.playerId] !== undefined &&
              (rankNotes[item.playerId] ?? "").trim() !== ""
                ? (rankNotes[item.playerId] ?? "").trim()
                : null,
          })),
        }),
      });
      setRankSavedSnapshot(JSON.stringify(rankItems.map((item) => [item.playerId])));
      announce("info", "Board saved.");
    } catch (error) {
      announce("error", error instanceof ApiError ? error.message : "Board save failed.");
    } finally {
      setRankSaving(false);
    }
  }, [announce, rankItems, rankNotes, rankSaving, rankScope]);

  // --- search ---------------------------------------------------------------

  useEffect(() => {
    if (playerQuery.trim().length < 2) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<{ id: string; displayName: string }[]>(
        `/api/v1/players?limit=8&name=${encodeURIComponent(playerQuery.trim())}`,
        { signal: controller.signal },
      )
        .then(setPlayerResults)
        .catch(() => {
          setPlayerResults([]);
        });
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [playerQuery]);

  useEffect(() => {
    if (teamQuery.trim().length < 2) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<{ id: string; name: string; city: string; abbreviation: string }[]>(
        `/api/v1/teams?q=${encodeURIComponent(teamQuery.trim())}`,
        { signal: controller.signal },
      )
        .then(setTeamResults)
        .catch(() => {
          setTeamResults([]);
        });
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [teamQuery]);

  const addPlayerPreference = useCallback(
    (playerId: string, displayName: string, listType: string) => {
      setDraft((previous) => {
        if (previous === null) return previous;
        const sign = listType === "FAVORITE" || listType === "TARGET" ? 0.5 : -0.5;
        if (
          previous.playerPreferences.some(
            (entry) => entry.playerId === playerId && entry.listType === listType,
          )
        ) {
          return previous;
        }
        return {
          ...previous,
          playerPreferences: [
            ...previous.playerPreferences.filter(
              (entry) => !(entry.playerId === playerId && entry.listType === listType),
            ),
            { playerId, listType, magnitude: sign },
          ],
        };
      });
      announce("info", `${displayName} added to ${listType.toLowerCase()} list.`);
    },
    [announce],
  );

  const removePlayerPreference = useCallback((playerId: string, listType: string): void => {
    setDraft((previous) =>
      previous === null
        ? previous
        : {
            ...previous,
            playerPreferences: previous.playerPreferences.filter(
              (entry) => !(entry.playerId === playerId && entry.listType === listType),
            ),
          },
    );
  }, []);

  const addTeamPreference = useCallback(
    (teamId: string, label: string, listType: "FAVORITE" | "DISLIKED") => {
      setDraft((previous) => {
        if (previous === null) return previous;
        if (previous.teamPreferences.some((entry) => entry.teamId === teamId)) return previous;
        return {
          ...previous,
          teamPreferences: [
            ...previous.teamPreferences,
            { teamId, listType, magnitude: listType === "FAVORITE" ? 0.4 : -0.4 },
          ],
        };
      });
      announce("info", `${label} added to ${listType.toLowerCase()} teams.`);
    },
    [announce],
  );

  const activePresetKey = draft === null ? null : draft.presetKey;
  const activePresetTitle =
    activePresetKey === null ? null : (getPreset(activePresetKey)?.title ?? null);
  const playerNameById = useMemo(() => new Map<string, string>(), []);

  if (loadingList && profiles.length === 0) {
    return (
      <div className="dc-page">
        <h1>Preferences</h1>
        <p className="dc-hint">Loading your profiles…</p>
      </div>
    );
  }

  return (
    <div className="dc-page">
      <h1>Preferences</h1>
      <p className="dc-hint">
        Saved preferences shape future drafts. An in-progress draft keeps its own snapshot.
      </p>

      <div aria-live="polite" className="dc-visually-hidden" role="status">
        {banner?.message ?? ""}
      </div>
      {banner !== null && (
        <p
          className="dc-status-banner"
          {...(banner.tone === "error" ? { role: "alert", "data-tone": "error" } : {})}
        >
          {banner.message}
        </p>
      )}

      <div className="dc-pref-layout">
        <nav className="dc-pref-rail" aria-label="Your profiles">
          <button
            type="button"
            className="dc-button-primary"
            onClick={() => {
              void selectProfile(NEW_PROFILE_ID);
            }}
          >
            New profile
          </button>
          <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0 }}>
            {profiles.map((profile) => (
              <li key={profile.id}>
                <button
                  type="button"
                  className="dc-pref-profile-row"
                  aria-current={selectedId === profile.id}
                  onClick={() => {
                    void selectProfile(profile.id);
                  }}
                >
                  <span className="dc-pref-star" aria-hidden="true">
                    {profile.isDefault ? "★" : ""}
                  </span>
                  <span className="dc-pref-profile-name">{profile.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <section aria-label="Profile editor">
          {draft === null ? (
            <p className="dc-hint">
              No profile selected — create one to start tuning your strategy.
            </p>
          ) : loadingDetail ? (
            <p className="dc-hint">Loading profile…</p>
          ) : (
            <>
              <h2>{draft.id === "" ? "New profile" : draft.name}</h2>
              {draft.id !== "" && (
                <p>
                  <button type="button" disabled={saving} onClick={() => void duplicateProfile()}>
                    Duplicate profile
                  </button>
                </p>
              )}

              <div className="dc-field">
                <label htmlFor="pref-name">Profile name</label>
                <input
                  id="pref-name"
                  value={draft.name}
                  maxLength={80}
                  onChange={(event) => {
                    setDraft({ ...draft, name: event.target.value });
                  }}
                />
              </div>

              <div className="dc-field-checkbox">
                <input
                  id="pref-default"
                  type="checkbox"
                  checked={draft.isDefault}
                  onChange={(event) => {
                    setDraft({ ...draft, isDefault: event.target.checked });
                  }}
                />
                <label htmlFor="pref-default">Use as my default profile</label>
              </div>

              {pendingSwitchId !== null && (
                <div className="dc-confirm-panel" role="alertdialog" aria-label="Unsaved changes">
                  <strong>You have unsaved changes.</strong>
                  <button
                    type="button"
                    onClick={() => {
                      setPendingSwitchId(null);
                    }}
                  >
                    Keep editing
                  </button>
                  <button
                    type="button"
                    className="dc-button-primary"
                    onClick={() => {
                      const target = pendingSwitchId;
                      setPendingSwitchId(null);
                      setSaved(null);
                      setDirtyBypass();
                      void selectProfile(target);
                    }}
                  >
                    Discard & switch
                  </button>
                </div>
              )}

              <div className="dc-pref-section">
                <h2>Presets</h2>
                {activePresetTitle !== null && (
                  <p className="dc-hint">Based on the “{activePresetTitle}” preset.</p>
                )}
                <PresetGallery
                  presets={preferencePresets.map((preset) => ({
                    key: preset.key,
                    title: preset.title,
                    explanation: preset.explanation,
                  }))}
                  activeKey={activePresetTitle === null ? null : draft.presetKey}
                  disabled={saving}
                  onApply={applyPresetByKey}
                />
                <p className="dc-hint">{strategyPreview(draft.settings)}</p>
              </div>

              <fieldset className="dc-pref-section">
                <legend>
                  <h2>Strategy factors</h2>
                </legend>
                {[...defaultFactorPriority].map((key) => (
                  <FactorSliderRow
                    key={key}
                    label={FACTOR_LABELS[key]}
                    value={draft.settings.factorWeights[key]}
                    locked={draft.settings.lockedFactors.includes(key)}
                    onValueChange={(value) => {
                      onFactorChange(key, value);
                    }}
                    onToggleLock={() => {
                      onToggleLock(key);
                    }}
                  />
                ))}
              </fieldset>

              <details className="dc-pref-section">
                <summary>
                  <h2>Advanced controls</h2>
                </summary>
                <fieldset style={{ border: 0 }}>
                  <legend>Risk, age, and role</legend>
                  <FactorSliderRow
                    label="Risk tolerance"
                    showLock={false}
                    value={draft.settings.riskTolerance}
                    onValueChange={(value) => {
                      mutateSettings((settings) => ({ ...settings, riskTolerance: value }));
                    }}
                  />
                  <FactorSliderRow
                    label="Upside priority"
                    showLock={false}
                    value={draft.settings.upsidePriority}
                    onValueChange={(value) => {
                      mutateSettings((settings) => ({ ...settings, upsidePriority: value }));
                    }}
                  />
                  <FactorSliderRow
                    label="Youth bias"
                    showLock={false}
                    value={(draft.settings.youthBias + 1) / 2}
                    onValueChange={(value) => {
                      mutateSettings((settings) => ({ ...settings, youthBias: value * 2 - 1 }));
                    }}
                  />
                  <FactorSliderRow
                    label="Role / minutes"
                    showLock={false}
                    value={draft.settings.roleMinutesPriority}
                    onValueChange={(value) => {
                      mutateSettings((settings) => ({ ...settings, roleMinutesPriority: value }));
                    }}
                  />
                </fieldset>

                <fieldset style={{ border: 0 }}>
                  <legend>Schedule</legend>
                  <div className="dc-field-checkbox">
                    <input
                      id="sched-enabled"
                      type="checkbox"
                      checked={draft.settings.schedule.enabled}
                      onChange={(event) => {
                        mutateSettings((settings) => ({
                          ...settings,
                          schedule: { ...settings.schedule, enabled: event.target.checked },
                        }));
                      }}
                    />
                    <label htmlFor="sched-enabled">Value fantasy-playoff-week games</label>
                  </div>
                  <div className="dc-field">
                    <label htmlFor="sched-weeks">Playoff weeks (1–14)</label>
                    <input
                      id="sched-weeks"
                      type="number"
                      min={1}
                      max={14}
                      value={draft.settings.schedule.playoffWeeks ?? ""}
                      onChange={(event) => {
                        const raw = event.target.value;
                        mutateSettings((settings) => ({
                          ...settings,
                          schedule: {
                            enabled: settings.schedule.enabled,
                            playoffWeeks: raw === "" ? null : Number(raw),
                          },
                        }));
                      }}
                    />
                  </div>
                </fieldset>

                <fieldset style={{ border: 0 }}>
                  <legend>Avoid mode</legend>
                  <div className="dc-field-checkbox">
                    <input
                      id="avoid-exclude"
                      type="radio"
                      name="avoid-mode"
                      checked={draft.settings.avoidMode === "EXCLUDE"}
                      onChange={() => {
                        mutateSettings((settings) => ({ ...settings, avoidMode: "EXCLUDE" }));
                      }}
                    />
                    <label htmlFor="avoid-exclude">Exclude avoided players entirely</label>
                  </div>
                  <div className="dc-field-checkbox">
                    <input
                      id="avoid-penalty"
                      type="radio"
                      name="avoid-mode"
                      checked={draft.settings.avoidMode === "SEVERE_PENALTY"}
                      onChange={() => {
                        mutateSettings((settings) => ({
                          ...settings,
                          avoidMode: "SEVERE_PENALTY",
                        }));
                      }}
                    />
                    <label htmlFor="avoid-penalty">Severe penalty only (still visible)</label>
                  </div>
                </fieldset>

                <fieldset style={{ border: 0 }}>
                  <legend>Category emphasis and punts</legend>
                  {CATEGORY_STATS.map((stat) => {
                    const entry = draft.settings.categoryPriorities.find((c) => c.stat === stat);
                    const punted = draft.settings.puntStats.includes(stat);
                    return (
                      <div key={stat} className="dc-field-checkbox">
                        <input
                          id={`cat-${stat}`}
                          type="checkbox"
                          checked={entry !== undefined || punted}
                          onChange={(event) => {
                            mutateSettings((settings) => {
                              const rest = settings.categoryPriorities.filter(
                                (c) => c.stat !== stat,
                              );
                              const puntStats = settings.puntStats.filter((s) => s !== stat);
                              if (event.target.checked) {
                                rest.push({ stat, weight: punted ? 0 : 1 });
                                if (punted) puntStats.push(stat);
                              }
                              return { ...settings, categoryPriorities: rest, puntStats };
                            });
                          }}
                        />
                        <label htmlFor={`cat-${stat}`}>{stat}</label>
                        {(entry !== undefined || punted) && (
                          <>
                            <input
                              type="range"
                              min={0}
                              max={1}
                              step={0.05}
                              value={punted || entry === undefined ? 0 : entry.weight}
                              aria-label={`${stat} emphasis`}
                              disabled={punted}
                              onChange={(event) => {
                                const weight = Number(event.target.value);
                                mutateSettings((settings) => ({
                                  ...settings,
                                  categoryPriorities: settings.categoryPriorities.map((c) =>
                                    c.stat === stat ? { stat, weight } : c,
                                  ),
                                }));
                              }}
                            />
                            <label>
                              <input
                                type="checkbox"
                                checked={punted}
                                aria-label={`Punt ${stat}`}
                                onChange={(event) => {
                                  const checked = event.target.checked;
                                  mutateSettings((settings) => {
                                    const puntStats = checked
                                      ? [...new Set([...settings.puntStats, stat])]
                                      : settings.puntStats.filter((s) => s !== stat);
                                    const categoryPriorities = settings.categoryPriorities.some(
                                      (c) => c.stat === stat,
                                    )
                                      ? settings.categoryPriorities.map((c) =>
                                          c.stat === stat ? { stat, weight: checked ? 0 : 1 } : c,
                                        )
                                      : [
                                          ...settings.categoryPriorities,
                                          { stat, weight: checked ? 0 : 1 },
                                        ];
                                    return { ...settings, categoryPriorities, puntStats };
                                  });
                                }}
                              />{" "}
                              Punt
                            </label>
                          </>
                        )}
                      </div>
                    );
                  })}
                </fieldset>
              </details>

              <div className="dc-pref-section">
                <h2>Players and teams</h2>
                <div className="dc-field">
                  <label htmlFor="player-search">Find players</label>
                  <input
                    id="player-search"
                    type="search"
                    placeholder="Type at least 2 letters…"
                    value={playerQuery}
                    onChange={(event) => {
                      setPlayerQuery(event.target.value);
                    }}
                  />
                </div>
                <ul className="dc-entry-list">
                  {(playerQuery.trim().length >= 2 ? playerResults : []).map((result) => (
                    <li key={result.id}>
                      <span className="dc-entry-name">{result.displayName}</span>
                      {(["FAVORITE", "TARGET", "DISLIKED", "AVOID"] as const).map((listType) => (
                        <button
                          key={listType}
                          type="button"
                          className="dc-mini-button"
                          aria-label={`Add ${result.displayName} to ${listType.toLowerCase()}`}
                          onClick={() => {
                            addPlayerPreference(result.id, result.displayName, listType);
                          }}
                        >
                          {listType.slice(0, 1)}
                        </button>
                      ))}
                    </li>
                  ))}
                </ul>
                {(["FAVORITE", "TARGET", "DISLIKED", "AVOID"] as const).map((listType) => (
                  <div key={listType}>
                    <h3>{listType.charAt(0) + listType.slice(1).toLowerCase()}</h3>
                    <ul className="dc-entry-list">
                      {draft.playerPreferences
                        .filter((entry) => entry.listType === listType)
                        .map((entry) => {
                          const name =
                            playerNameById.get(entry.playerId) ??
                            `${entry.listType.toLowerCase()} player ${entry.playerId.slice(0, 6)}…`;
                          return (
                            <li key={`${entry.playerId}:${entry.listType}`}>
                              <span className="dc-entry-name" title={name}>
                                {name}
                              </span>
                              <span className="dc-factor-value">{entry.magnitude.toFixed(2)}</span>
                              <button
                                type="button"
                                className="dc-mini-button"
                                aria-label={`Remove ${name} from ${listType.toLowerCase()}`}
                                onClick={() => {
                                  removePlayerPreference(entry.playerId, listType);
                                }}
                              >
                                ✕
                              </button>
                            </li>
                          );
                        })}
                    </ul>
                  </div>
                ))}

                <div className="dc-field">
                  <label htmlFor="team-search">Find teams</label>
                  <input
                    id="team-search"
                    type="search"
                    value={teamQuery}
                    onChange={(event) => {
                      setTeamQuery(event.target.value);
                    }}
                  />
                </div>
                <ul className="dc-entry-list">
                  {(teamQuery.trim().length >= 2 ? teamResults : []).map((team) => (
                    <li key={team.id}>
                      <span className="dc-entry-name">
                        {team.city} {team.name} ({team.abbreviation})
                      </span>
                      <button
                        type="button"
                        className="dc-mini-button"
                        aria-label={`Favorite ${team.name}`}
                        onClick={() => {
                          addTeamPreference(team.id, team.name, "FAVORITE");
                        }}
                      >
                        ♥
                      </button>
                      <button
                        type="button"
                        className="dc-mini-button"
                        aria-label={`Dislike ${team.name}`}
                        onClick={() => {
                          addTeamPreference(team.id, team.name, "DISLIKED");
                        }}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
                {draft.teamPreferences.length > 0 && (
                  <ul className="dc-entry-list">
                    {draft.teamPreferences.map((entry) => (
                      <li key={entry.teamId}>
                        <span className="dc-entry-name">
                          Team {entry.listType.toLowerCase()} · magnitude{" "}
                          {entry.magnitude.toFixed(2)}
                        </span>
                        <button
                          type="button"
                          className="dc-mini-button"
                          aria-label={`Remove team preference for ${entry.teamId}`}
                          onClick={() => {
                            setDraft({
                              ...draft,
                              teamPreferences: draft.teamPreferences.filter(
                                (candidate) => candidate.teamId !== entry.teamId,
                              ),
                            });
                          }}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {draft.id !== "" && (
                <div className="dc-confirm-panel">
                  <strong>Danger zone:</strong> delete this profile.
                  {deleteArmed ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setDeleteArmed(false);
                        }}
                      >
                        Cancel delete
                      </button>
                      <button
                        type="button"
                        className="dc-button-primary"
                        onClick={() => {
                          void deleteSelected();
                        }}
                      >
                        Confirm delete
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setDeleteArmed(true);
                      }}
                    >
                      Delete profile…
                    </button>
                  )}
                </div>
              )}

              {(dirty || draft.id === "") && (
                <div className="dc-save-bar">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      setDraft(structuredClone(saved));
                    }}
                  >
                    Discard changes
                  </button>
                  <button
                    type="button"
                    className="dc-button-primary"
                    disabled={saving}
                    onClick={() => {
                      void save();
                    }}
                  >
                    {saving ? "Saving…" : "Save preferences"}
                  </button>
                </div>
              )}

              <div className="dc-pref-section">
                <h2>Custom big board</h2>
                <label className="dc-field">
                  <span>Board scope</span>
                  <select
                    value={rankScope}
                    onChange={(event) => {
                      setRankScope(event.target.value);
                    }}
                  >
                    <option value="global">Global board</option>
                    {leagues.map((league) => (
                      <option key={league.id} value={league.id}>
                        League: {league.name}
                      </option>
                    ))}
                  </select>
                </label>
                <RankListEditor
                  items={rankItems}
                  notes={rankNotes}
                  labelId="rank-board-label"
                  onMove={moveRank}
                  onRemove={(playerId) => {
                    setRankItems((previous) =>
                      previous.filter((item) => item.playerId !== playerId),
                    );
                  }}
                  onNoteChange={(playerId, note) => {
                    setRankNotes((previous) => ({ ...previous, [playerId]: note }));
                  }}
                />
                {rankItems.length > 0 && (
                  <p>
                    <button
                      type="button"
                      className="dc-button-primary"
                      disabled={rankSaving || !ranksDirty}
                      onClick={() => {
                        void saveRanks();
                      }}
                    >
                      {rankSaving ? "Saving board…" : "Save board order"}
                    </button>
                  </p>
                )}
                <div className="dc-field">
                  <label htmlFor="board-search">Add player to board</label>
                  <input
                    id="board-search"
                    type="search"
                    value={playerQuery}
                    onChange={(event) => {
                      setPlayerQuery(event.target.value);
                    }}
                  />
                </div>
                <ul className="dc-entry-list">
                  {(playerQuery.trim().length >= 2 ? playerResults : []).map((result) => (
                    <li key={`board-${result.id}`}>
                      <span className="dc-entry-name">{result.displayName}</span>
                      <button
                        type="button"
                        className="dc-mini-button"
                        aria-label={`Add ${result.displayName} to board`}
                        disabled={rankItems.some((item) => item.playerId === result.id)}
                        onClick={() => {
                          setRankItems((previous) =>
                            previous.some((item) => item.playerId === result.id)
                              ? previous
                              : [
                                  ...previous,
                                  { playerId: result.id, displayName: result.displayName },
                                ],
                          );
                        }}
                      >
                        Add
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );

  function setDirtyBypass(): void {
    // Switching after explicit discard: clear dirty by dropping the draft so
    // the next load starts clean.
    setDraft(null);
    setSaved(null);
  }
}
