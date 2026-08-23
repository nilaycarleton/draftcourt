"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  defaultRosterSlots,
  eightCategoryPreset,
  leagueCreateSchema,
  nineCategoryPreset,
  pointsPreset,
  type ScoringRuleInput,
} from "@draftcourt/domain";

/**
 * `/leagues/new` multi-step wizard (Impeccable shape:
 * docs/design/phase2-shape.md). Save-and-resume via localStorage; inline
 * per-step validation against the SAME schema the API enforces; review step
 * explains scoring concepts in plain language before submission.
 */

const STORAGE_KEY = "draftcourt-league-wizard";

const STEPS = ["Basics", "Scoring", "Roster", "Teams", "Review"] as const;

interface WizardState {
  name: string;
  season: string;
  teamCount: number;
  userDraftSlot: number;
  rounds: number;
  type: "POINTS" | "CATEGORIES";
  horizon: "REDRAFT" | "KEEPER" | "DYNASTY";
  playoffWeeks: number | null;
  scoringRules: ScoringRuleInput[];
}

const INITIAL: WizardState = {
  name: "",
  season: "2026-27",
  teamCount: 12,
  userDraftSlot: 1,
  rounds: 13,
  type: "POINTS",
  horizon: "REDRAFT",
  playoffWeeks: null,
  scoringRules: [],
};

type PresetKey = "points" | "eight" | "nine" | null;

function presetFor(type: WizardState["type"], key: PresetKey): ScoringRuleInput[] {
  if (type === "POINTS") return pointsPreset();
  if (key === "eight") return eightCategoryPreset();
  if (key === "nine") return nineCategoryPreset();
  return nineCategoryPreset();
}

export function LeagueWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>(INITIAL);
  const [preset, setPreset] = useState<PresetKey>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Save-and-resume: lazy-init from localStorage avoids a setState-in-effect
  // cascade; persistence runs after every render commit.
  useEffect(() => {
    const persist = (): void => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    };
    const timeout = window.setTimeout(persist, 0);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [state]);

  const update = useCallback((patch: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const rosterTotal = useMemo(
    () => defaultRosterSlots().reduce((sum: number, slotDef) => sum + slotDef.count, 0),
    [],
  );

  function validateStep(current: number): string | null {
    if (current === 0 && state.name.trim().length === 0) return "Give your league a name.";
    if (current === 1) {
      // An untouched step shows its type-appropriate defaults already; only
      // an impossible custom state (all rules deleted) blocks progress.
      const effective =
        state.scoringRules.length > 0 ? state.scoringRules : presetFor(state.type, preset);
      if (effective.length === 0) return "Pick a preset or add at least one rule.";
    }
    if (current === 3 && state.userDraftSlot > state.teamCount)
      return "Your draft slot must be within the team count.";
    return null;
  }

  function next() {
    const problem = validateStep(step);
    setError(problem);
    if (!problem) setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        name: state.name.trim(),
        season: state.season,
        teamCount: state.teamCount,
        userDraftSlot: state.userDraftSlot,
        rounds: Math.max(state.rounds, rosterTotal),
        config: {
          type: state.type,
          horizon: state.horizon,
          playoffWeeks: state.playoffWeeks,
          scoringRules:
            state.scoringRules.length > 0 ? state.scoringRules : presetFor(state.type, preset),
          rosterSlots: defaultRosterSlots(),
        },
      };
      const parsed = leagueCreateSchema.safeParse(payload);
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? "Please fix the highlighted fields.");
        setSubmitting(false);
        return;
      }
      const response = await fetch("/api/v1/leagues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const bodyJson = (await response.json()) as {
        data?: { id: string };
        error?: { detail?: string };
      };
      if (!response.ok || !bodyJson.data) {
        throw new Error(bodyJson.error?.detail ?? "Could not save the league.");
      }
      window.localStorage.removeItem(STORAGE_KEY);
      router.push(`/leagues/${bodyJson.data.id}/settings`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Something went wrong.");
      setSubmitting(false);
    }
  }

  return (
    <div className="dc-wizard">
      <ol className="dc-wizard-rail" aria-label="Setup steps">
        {STEPS.map((label, index) => (
          <li
            key={label}
            aria-current={index === step ? "step" : undefined}
            className={index <= step ? "dc-wizard-step done" : "dc-wizard-step"}
          >
            <span className="dc-wizard-index">{index + 1}</span> {label}
          </li>
        ))}
      </ol>

      {error !== null && (
        <p className="dc-form-error" role="alert">
          {error}
        </p>
      )}

      {step === 0 && (
        <fieldset className="dc-fieldset">
          <legend>Basics</legend>
          <label className="dc-field">
            <span>League name</span>
            <input
              value={state.name}
              onChange={(event) => {
                update({ name: event.target.value });
              }}
              maxLength={80}
            />
          </label>
          <label className="dc-field">
            <span>Season</span>
            <input
              value={state.season}
              onChange={(e) => {
                update({ season: e.target.value });
              }}
            />
          </label>
          <label className="dc-field">
            <span>Scoring type</span>
            <select
              value={state.type}
              onChange={(e) => {
                update({ type: e.target.value as WizardState["type"], scoringRules: [] });
                setPreset(null);
              }}
            >
              <option value="POINTS">Points (weighted stats)</option>
              <option value="CATEGORIES">Categories (8-cat / 9-cat style)</option>
            </select>
          </label>
          <label className="dc-field">
            <span>Horizon</span>
            <select
              value={state.horizon}
              onChange={(e) => {
                update({ horizon: e.target.value as WizardState["horizon"] });
              }}
            >
              <option value="REDRAFT">Redraft</option>
              <option value="KEEPER">Keeper</option>
              <option value="DYNASTY">Dynasty</option>
            </select>
          </label>
        </fieldset>
      )}

      {step === 1 && (
        <fieldset className="dc-fieldset">
          <legend>Scoring rules</legend>
          <p className="dc-hint">
            {state.type === "POINTS"
              ? "Points leagues assign each stat a value (turnovers may be negative)."
              : "Category leagues compare your team in each category; percentages are volume-aware and never averaged."}
          </p>
          {state.type === "CATEGORIES" && (
            <div className="dc-preset-row" role="group" aria-label="Presets">
              <button
                type="button"
                onClick={() => {
                  setPreset("eight");
                  update({ scoringRules: eightCategoryPreset() });
                }}
              >
                8-cat preset
              </button>
              <button
                type="button"
                onClick={() => {
                  setPreset("nine");
                  update({ scoringRules: nineCategoryPreset() });
                }}
              >
                9-cat preset
              </button>
            </div>
          )}
          <ul className="dc-rule-list">
            {(state.scoringRules.length > 0
              ? state.scoringRules
              : presetFor(state.type, preset)
            ).map((rule) => (
              <li key={rule.stat}>
                <label className="dc-rule-edit">
                  <strong>{rule.stat}</strong>
                  {rule.direction === "LOWER_BETTER" ? " (lower is better)" : ""}
                  {": "}
                  <input
                    type="number"
                    step="0.1"
                    min={rule.punt ? 0 : -1000}
                    max={1000}
                    value={rule.weight}
                    aria-label={`${rule.stat} weight`}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      const nextRules =
                        state.scoringRules.length > 0
                          ? state.scoringRules.map((existing) =>
                              existing.stat === rule.stat
                                ? { ...existing, weight: value }
                                : existing,
                            )
                          : presetFor(state.type, preset).map((existing) =>
                              existing.stat === rule.stat
                                ? { ...existing, weight: value }
                                : existing,
                            );
                      update({ scoringRules: nextRules });
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const nextRules =
                        state.scoringRules.length > 0
                          ? state.scoringRules.map((existing) =>
                              existing.stat === rule.stat
                                ? {
                                    ...existing,
                                    punt: !existing.punt,
                                    weight: existing.punt ? 1 : 0,
                                  }
                                : existing,
                            )
                          : presetFor(state.type, preset);
                      update({ scoringRules: nextRules });
                    }}
                  >
                    {rule.punt ? "Un-punt" : "Punt"}
                  </button>
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="dc-button-ghost"
            onClick={() => {
              update({ scoringRules: presetFor(state.type, preset) });
            }}
          >
            Reset to {state.type === "POINTS" ? "points" : preset === "eight" ? "8-cat" : "9-cat"}{" "}
            defaults
          </button>
        </fieldset>
      )}

      {step === 2 && (
        <fieldset className="dc-fieldset">
          <legend>Roster slots</legend>
          <ul className="dc-rule-list">
            {defaultRosterSlots().map((slot) => (
              <li key={slot.position}>
                {slot.count} × {slot.position}
                {slot.starter ? "" : " (bench)"}
              </li>
            ))}
          </ul>
          <p className="dc-hint">
            Standard lineup: starters first, then bench. Total roster size is {rosterTotal}; your
            draft needs at least that many rounds.
          </p>
        </fieldset>
      )}

      {step === 3 && (
        <fieldset className="dc-fieldset">
          <legend>Teams</legend>
          <label className="dc-field">
            <span>Teams in league</span>
            <input
              type="number"
              min={4}
              max={20}
              value={state.teamCount}
              onChange={(e) => {
                update({ teamCount: Number(e.target.value) });
              }}
            />
          </label>
          <label className="dc-field">
            <span>Your draft slot</span>
            <input
              type="number"
              min={1}
              max={state.teamCount}
              value={state.userDraftSlot}
              onChange={(e) => {
                update({ userDraftSlot: Number(e.target.value) });
              }}
            />
          </label>
          <label className="dc-field">
            <span>Draft rounds</span>
            <input
              type="number"
              min={rosterTotal}
              max={30}
              value={state.rounds}
              onChange={(e) => {
                update({ rounds: Number(e.target.value) });
              }}
            />
          </label>
        </fieldset>
      )}

      {step === 4 && (
        <div className="dc-review">
          <h2>Review</h2>
          <dl className="dc-review-list">
            <dt>Name</dt>
            <dd>{state.name || "—"}</dd>
            <dt>Type</dt>
            <dd>
              {state.type === "POINTS"
                ? "Points league — each stat has a value."
                : "Category league — win categories; percentages are volume-aware, never averaged."}
            </dd>
            <dt>Horizon</dt>
            <dd>{state.horizon}</dd>
            <dt>Punts</dt>
            <dd>
              {state.scoringRules
                .filter((r) => r.punt)
                .map((r) => r.stat)
                .join(", ") || "none"}{" "}
              — punted categories contribute zero.
            </dd>
            <dt>Lower-is-better</dt>
            <dd>TOV counts against you automatically.</dd>
            <dt>Teams</dt>
            <dd>
              {state.teamCount}, you pick at slot {state.userDraftSlot}
            </dd>
            <dt>Rounds</dt>
            <dd>{Math.max(state.rounds, rosterTotal)}</dd>
          </dl>
        </div>
      )}

      <div className="dc-wizard-actions">
        {step > 0 && (
          <button
            type="button"
            className="dc-button-ghost"
            onClick={() => {
              setStep((s) => s - 1);
            }}
          >
            Back
          </button>
        )}
        {step < STEPS.length - 1 ? (
          <button type="button" className="dc-button-primary" onClick={next}>
            Continue
          </button>
        ) : (
          <button
            type="button"
            className="dc-button-primary"
            onClick={() => {
              void submit();
            }}
            disabled={submitting}
          >
            {submitting ? "Saving…" : "Create league"}
          </button>
        )}
      </div>
    </div>
  );
}
