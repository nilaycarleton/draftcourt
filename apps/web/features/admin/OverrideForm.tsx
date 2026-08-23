"use client";

import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";
import { OVERRIDABLE_STATS } from "@/lib/shared/admin-constants";

const VALUE_MODES = ["delta", "replacement"] as const;

function str(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

interface ApiErrorPayload {
  error: { detail?: string } | null;
}

export function OverrideForm() {
  const router = useRouter();
  const [valueMode, setValueMode] = useState<(typeof VALUE_MODES)[number]>("delta");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const currentTarget = event.currentTarget;
    const form = new FormData(currentTarget);
    const value = Number(form.get("value"));
    const expiresAtRaw = str(form.get("expiresAt"));

    const body = {
      playerId: str(form.get("playerId")),
      season: str(form.get("season")),
      stat: str(form.get("stat")),
      rationale: str(form.get("rationale")),
      effectiveAt: new Date().toISOString(),
      ...(valueMode === "delta" ? { deltaValue: value } : { replacementValue: value }),
      ...(expiresAtRaw ? { expiresAt: new Date(expiresAtRaw).toISOString() } : {}),
    };

    try {
      const response = await fetch("/api/v1/admin/projection-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as ApiErrorPayload;
      if (!response.ok) {
        setError(payload.error?.detail ?? "The override could not be created.");
        return;
      }
      currentTarget.reset();
      router.refresh();
    } catch {
      setError("The override could not be created. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="dc-filter-form"
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
      aria-label="Create a projection override"
    >
      <div className="dc-filter-row">
        <label className="dc-field">
          <span>Player ID</span>
          <input type="text" name="playerId" required placeholder="uuid" />
        </label>
        <label className="dc-field">
          <span>Season</span>
          <input type="text" name="season" required defaultValue="2026-27" />
        </label>
        <label className="dc-field">
          <span>Stat</span>
          <select name="stat" required>
            {OVERRIDABLE_STATS.map((stat) => (
              <option key={stat} value={stat}>
                {stat}
              </option>
            ))}
          </select>
        </label>
        <label className="dc-field">
          <span>Value type</span>
          <select
            value={valueMode}
            onChange={(e) => {
              setValueMode(e.target.value as (typeof VALUE_MODES)[number]);
            }}
          >
            {VALUE_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode === "delta" ? "Delta (+/-)" : "Replacement value"}
              </option>
            ))}
          </select>
        </label>
        <label className="dc-field">
          <span>{valueMode === "delta" ? "Delta" : "Replacement value"}</span>
          <input
            type="number"
            name="value"
            step="any"
            required
            min={valueMode === "replacement" ? 0 : undefined}
          />
        </label>
        <label className="dc-field">
          <span>Expires (optional)</span>
          <input type="datetime-local" name="expiresAt" />
        </label>
      </div>
      <label className="dc-field">
        <span>Rationale (required)</span>
        <input
          type="text"
          name="rationale"
          required
          minLength={1}
          placeholder="Why this override is warranted"
        />
      </label>
      {error && (
        <p role="alert" className="dc-status-tag dc-status-suspended">
          {error}
        </p>
      )}
      <div className="dc-filter-actions">
        <button type="submit" className="dc-button-primary" disabled={submitting}>
          {submitting ? "Creating…" : "Create override"}
        </button>
      </div>
    </form>
  );
}
