"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { cpuPersonalities } from "@draftcourt/domain";

/**
 * Demo draft creation flow (Phase 3D).
 * Simplified version of StartDraftFlow for unauthenticated guests.
 */

interface DemoPreset {
  key: "standard" | "categories" | "dynasty";
  name: string;
  description: string;
  teamCount: number;
  userDraftSlot: number;
  rounds: number;
}

const DEMO_PRESETS: readonly DemoPreset[] = [
  {
    key: "standard",
    name: "Standard 12-Team Points",
    description: "Points league, 14 rounds, balanced scoring",
    teamCount: 12,
    userDraftSlot: 7,
    rounds: 14,
  },
  {
    key: "categories",
    name: "Standard 12-Team 9-Cat",
    description: "9-category league, 14 rounds",
    teamCount: 12,
    userDraftSlot: 7,
    rounds: 14,
  },
  {
    key: "dynasty",
    name: "12-Team Dynasty",
    description: "Dynasty format, 16 rounds, youth emphasis",
    teamCount: 12,
    userDraftSlot: 7,
    rounds: 16,
  },
] as const;

const SIMULATION_SEED_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export function DemoDraftFlow() {
  const router = useRouter();
  const [presetKey, setPresetKey] = useState<(typeof DEMO_PRESETS)[number]["key"]>("standard");
  const [userDraftSlot, setUserDraftSlot] = useState<string>("");
  const [cpuPersonalityKey, setCpuPersonalityKey] = useState<string | undefined>(undefined);
  const [simulationSeed, setSimulationSeed] = useState<string>("");
  const [seedError, setSeedError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [recoveryToken, setRecoveryToken] = useState<string | null>(null);
  const [recoveryExpiresAt, setRecoveryExpiresAt] = useState<string | null>(null);
  const [recoveryDraftId, setRecoveryDraftId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const selectedPreset = DEMO_PRESETS.find((p) => p.key === presetKey);
  const maxSlot = selectedPreset?.teamCount ?? 12;
  const defaultCpuKey = cpuPersonalities[0]?.key ?? "balanced";
  const effectiveCpuKey = cpuPersonalityKey ?? defaultCpuKey;

  // Initialize slot from preset directly without effect — avoids cascading render.
  // The initial slot is set via the radio onChange when preset changes; no effect needed.

  const create = useCallback(async () => {
    if (creating) return;
    setErrorDetail(null);
    setSeedError(null);

    const rawSlot = userDraftSlot.trim();
    const slot =
      rawSlot === "" ? (selectedPreset?.userDraftSlot ?? 7) : Number.parseInt(rawSlot, 10);
    if (!Number.isInteger(slot) || slot < 1 || slot > maxSlot) {
      const maxSlotStr = String(maxSlot);
      setErrorDetail(`Draft slot must be 1–${maxSlotStr}`);
      return;
    }

    const seedValue = simulationSeed.trim();
    if (seedValue && !SIMULATION_SEED_PATTERN.test(seedValue)) {
      setSeedError("Use letters, numbers and dashes only (up to 64 characters).");
      return;
    }

    setCreating(true);
    try {
      const response = await fetch("/api/v1/demo-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          presetKey,
          userDraftSlot: slot,
          ...(effectiveCpuKey !== defaultCpuKey ? { cpuPersonalityKey: effectiveCpuKey } : {}),
          ...(seedValue ? { simulationSeed: seedValue } : {}),
        }),
      });

      const data = (await response.json().catch(() => null)) as {
        data?: { draftId: string; capabilityToken?: string; expiresAt?: string };
        error?: { detail: string };
      } | null;
      if (!response.ok || !data?.data?.draftId) {
        const detail = data?.error?.detail ?? "Demo creation failed";
        throw new Error(detail);
      }

      // Store recovery code for copy affordance (cookie also set); navigate immediately for test stability.
      if (data.data.capabilityToken && data.data.expiresAt) {
        setRecoveryToken(data.data.capabilityToken);
        setRecoveryExpiresAt(data.data.expiresAt);
        setRecoveryDraftId(data.data.draftId);
      }

      router.push(`/demo/${data.data.draftId}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Creation failed — try again";
      setErrorDetail(message);
    } finally {
      setCreating(false);
    }
  }, [
    creating,
    effectiveCpuKey,
    maxSlot,
    presetKey,
    router,
    selectedPreset,
    simulationSeed,
    userDraftSlot,
    defaultCpuKey,
  ]);

  return (
    <div className="dc-demo-flow">
      <div aria-live="polite" className="dc-visually-hidden" role="status">
        {creating ? "Creating demo draft…" : ""}
      </div>

      {errorDetail && (
        <div role="alert" className="dc-strategy-banner">
          <span>Could not create demo: {errorDetail}</span>
          <button
            type="button"
            disabled={creating}
            onClick={() => {
              setErrorDetail(null);
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      <fieldset className="dc-demo-fieldset">
        <legend>
          <h2>League Preset</h2>
        </legend>
        {DEMO_PRESETS.map((preset) => (
          <label key={preset.key} className="dc-strategy-option">
            <input
              type="radio"
              name="dc-demo-preset"
              value={preset.key}
              checked={presetKey === preset.key}
              onChange={() => {
                setPresetKey(preset.key);
                setUserDraftSlot(String(preset.userDraftSlot));
                setErrorDetail(null);
              }}
            />
            <span className="dc-strategy-option-name">{preset.name}</span>
            <small className="dc-strategy-meta">{preset.description}</small>
          </label>
        ))}
      </fieldset>

      <fieldset className="dc-demo-fieldset">
        <legend>
          <h2>Your Draft Slot</h2>
        </legend>
        <label htmlFor="demo-slot" className="dc-slot-input">
          <input
            id="demo-slot"
            type="number"
            min="1"
            max={maxSlot}
            value={userDraftSlot}
            onChange={(e) => {
              const val = e.target.value;
              if (val === "" || (Number(val) >= 1 && Number(val) <= maxSlot)) {
                setUserDraftSlot(val);
              }
            }}
            placeholder={`1–${String(maxSlot)}`}
            aria-describedby="demo-slot-hint"
          />
          <span id="demo-slot-hint" className="dc-hint">
            Pick 1–{String(maxSlot)} (default: {selectedPreset?.userDraftSlot ?? 7})
          </span>
        </label>
      </fieldset>

      <fieldset className="dc-demo-fieldset">
        <legend>
          <h2>CPU Personality</h2>
        </legend>
        <div className="dc-personality-selector">
          <label htmlFor="demo-personality" className="dc-label">
            Default for all CPU teams
          </label>
          <select
            id="demo-personality"
            value={cpuPersonalityKey ?? ""}
            onChange={(e) => {
              setCpuPersonalityKey(e.target.value || undefined);
            }}
            className="dc-select"
          >
            <option value="">Follow default (Balanced)</option>
            {cpuPersonalities
              .filter((p) => p.supportedModes.includes("DEMO"))
              .map((p) => (
                <option key={p.key} value={p.key}>
                  {p.displayName} — {p.description}
                </option>
              ))}
          </select>
        </div>
        <p className="dc-hint">All CPU opponents use this personality unless you override below.</p>
      </fieldset>

      <details className="dc-demo-advanced">
        <summary>Advanced: Per-team overrides</summary>
        <p className="dc-hint">
          Per-team personality overrides available after account signup. Demo uses single default
          for all CPU teams.
        </p>
      </details>

      <fieldset className="dc-demo-fieldset">
        <legend>
          <h2>Simulation Seed (Optional)</h2>
        </legend>
        <label htmlFor="demo-seed" className="dc-seed-input">
          <input
            id="demo-seed"
            type="text"
            value={simulationSeed}
            onChange={(e) => {
              setSimulationSeed(e.target.value);
              setSeedError(null);
            }}
            placeholder="Auto-generated if left blank"
            maxLength={64}
            aria-invalid={seedError !== null ? "true" : "false"}
            aria-describedby={seedError ? "demo-seed-error" : "demo-seed-hint"}
            className={seedError ? "dc-input-error" : ""}
          />
          <span id="demo-seed-hint" className="dc-hint">
            Letters, numbers, dashes only. Same seed = same draft.
          </span>
          {seedError && (
            <span id="demo-seed-error" role="alert" className="dc-error">
              {seedError}
            </span>
          )}
        </label>
      </fieldset>

      {recoveryToken && recoveryDraftId && (
        <div className="dc-demo-recovery" role="status" aria-live="polite">
          <h3>Recovery code — save this now</h3>
          <p className="dc-hint">
            This demo expires{" "}
            {recoveryExpiresAt
              ? `at ${new Date(recoveryExpiresAt).toLocaleString()}`
              : "in 24 hours"}
            . A secure HttpOnly cookie keeps you signed in on this device, but if you clear cookies
            or change device you will need this code via <code>Authorization: Bearer</code>.
          </p>
          <div className="dc-recovery-code">
            <code className="dc-mono" aria-label="Recovery token">
              {recoveryToken}
            </code>
            <button
              type="button"
              className="dc-button-secondary"
              onClick={() => {
                void (async () => {
                  try {
                    await navigator.clipboard.writeText(recoveryToken);
                    setCopied(true);
                    setTimeout(() => {
                      setCopied(false);
                    }, 2000);
                  } catch {
                    // fallback: select text
                  }
                })();
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="dc-hint">
            Keep this code private — anyone with it can access this demo until it expires.
          </p>
        </div>
      )}
      <button
        type="button"
        className="dc-button-primary dc-demo-create"
        onClick={() => {
          void create();
        }}
        disabled={creating}
      >
        {creating ? "Creating…" : "Start Demo Draft"}
      </button>
    </div>
  );
}
