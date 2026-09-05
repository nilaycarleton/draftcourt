"use client";

import { useCallback, useRef, useState } from "react";
import { getPreset } from "@draftcourt/domain";

/**
 * League-settings strategy picker (Phase 3B). Radio group choosing which of
 * the owner's preference profiles drafts from this league, or the fall-through
 * "use my default profile" option (null). Saving PATCHes the league; active
 * drafts are untouched — their locked snapshot is authoritative, which the
 * inline copy states plainly. Envelope-aware fetch mirrors
 * PreferencesWorkspace's `api()` helper.
 */

export interface PickerProfile {
  id: string;
  name: string;
  presetKey: string | null;
  presetVersion: number | null;
  isDefault: boolean;
}

export interface StrategySelectionSummary {
  preferredProfileId: string | null;
  preferredProfileName: string | null;
  defaultProfileId: string | null;
  defaultProfileName: string | null;
}

export interface StrategyProfilePickerProps {
  leagueId: string;
  profiles: PickerProfile[];
  selection: StrategySelectionSummary;
}

interface ApiEnvelope<T> {
  data?: T;
  error?: { detail?: string };
}

async function patchLeague(leagueId: string, preferredProfileId: string | null): Promise<void> {
  const response = await fetch(`/api/v1/leagues/${leagueId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preferredProfileId }),
  });
  const body = (await response.json().catch(() => null)) as ApiEnvelope<unknown> | null;
  if (!response.ok || body === null) {
    throw new Error(body?.error?.detail ?? "Request failed.");
  }
}

function presetLabel(profile: PickerProfile): string {
  if (profile.presetKey === null) return "Custom";
  const preset = getPreset(profile.presetKey);
  return preset ? preset.title : "Custom";
}

const NO_PREFERENCE = "";

export function StrategyProfilePicker({
  leagueId,
  profiles,
  selection,
}: StrategyProfilePickerProps): React.JSX.Element {
  const [value, setValue] = useState<string>(selection.preferredProfileId ?? NO_PREFERENCE);
  const [saving, setSaving] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);

  const defaultName = selection.defaultProfileName ?? "No default set";

  const save = useCallback(async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setErrorDetail(null);
    try {
      await patchLeague(leagueId, value === NO_PREFERENCE ? null : value);
      setSavedNote("Strategy saved — applies to drafts started after now.");
    } catch (cause) {
      setSavedNote(null);
      setErrorDetail(cause instanceof Error ? cause.message : "Saving failed — try again.");
    } finally {
      setSaving(false);
    }
  }, [leagueId, saving, value]);

  return (
    <section aria-label="Draft strategy" className="dc-strategy-picker">
      <h2>Draft strategy</h2>
      <p className="dc-hint">
        Applies to drafts started after you save. Active drafts keep their locked strategy.
      </p>

      <div aria-live="polite" className="dc-visually-hidden" role="status">
        {saving
          ? "Saving strategy…"
          : errorDetail !== null
            ? `Saving failed. ${errorDetail}`
            : (savedNote ?? "")}
      </div>

      {errorDetail !== null && (
        <div role="alert" className="dc-strategy-banner">
          <span>Could not save: {errorDetail}</span>
          <button type="button" onClick={() => void save()}>
            Retry
          </button>
        </div>
      )}
      {savedNote !== null && errorDetail === null && (
        <p className="dc-strategy-note">{savedNote}</p>
      )}

      <div role="radiogroup" aria-label="Preferred strategy profile">
        <label className="dc-strategy-option">
          <input
            type="radio"
            name="dc-strategy-choice"
            value={NO_PREFERENCE}
            checked={value === NO_PREFERENCE}
            onChange={() => {
              setValue(NO_PREFERENCE);
              setSavedNote(null);
            }}
          />
          <span className="dc-strategy-option-name">Use my default profile at draft time</span>
          <small className="dc-strategy-meta">{defaultName}</small>
        </label>

        {profiles.map((profile) => (
          <label key={profile.id} className="dc-strategy-option">
            <input
              type="radio"
              name="dc-strategy-choice"
              value={profile.id}
              checked={value === profile.id}
              onChange={() => {
                setValue(profile.id);
                setSavedNote(null);
              }}
            />
            <span className="dc-strategy-option-name" title={profile.name}>
              {profile.name}
            </span>
            <span className="dc-strategy-star" aria-hidden="true">
              {profile.isDefault ? "★" : ""}
            </span>
            <small className="dc-strategy-meta">{presetLabel(profile)}</small>
          </label>
        ))}
      </div>

      <p className="dc-strategy-save-row">
        <button
          ref={saveButtonRef}
          type="button"
          className="dc-button-primary"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save strategy"}
        </button>
      </p>
    </section>
  );
}
