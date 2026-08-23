"use client";

import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";
import { SIGNAL_TYPES } from "@/lib/shared/admin-constants";

function str(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

interface ApiErrorPayload {
  error: { detail?: string } | null;
}

export function SignalForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const currentTarget = event.currentTarget;
    const form = new FormData(currentTarget);
    const rationale = str(form.get("rationale")).trim();
    const expiresAtRaw = str(form.get("expiresAt"));

    const body = {
      playerId: str(form.get("playerId")),
      type: str(form.get("type")),
      impact: Number(form.get("impact")),
      confidence: Number(form.get("confidence")),
      effectiveAt: new Date().toISOString(),
      ...(rationale ? { rationale } : {}),
      ...(expiresAtRaw ? { expiresAt: new Date(expiresAtRaw).toISOString() } : {}),
    };

    try {
      const response = await fetch("/api/v1/admin/player-signals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as ApiErrorPayload;
      if (!response.ok) {
        setError(payload.error?.detail ?? "The signal could not be created.");
        return;
      }
      currentTarget.reset();
      router.refresh();
    } catch {
      setError("The signal could not be created. Check your connection and try again.");
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
      aria-label="Log a player news signal"
    >
      <div className="dc-filter-row">
        <label className="dc-field">
          <span>Player ID</span>
          <input type="text" name="playerId" required placeholder="uuid" />
        </label>
        <label className="dc-field">
          <span>Type</span>
          <select name="type" required>
            {SIGNAL_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="dc-field">
          <span>Impact (0–1)</span>
          <input
            type="number"
            name="impact"
            min={0}
            max={1}
            step={0.05}
            required
            defaultValue={0.5}
          />
        </label>
        <label className="dc-field">
          <span>Confidence (0–1)</span>
          <input
            type="number"
            name="confidence"
            min={0}
            max={1}
            step={0.05}
            required
            defaultValue={0.7}
          />
        </label>
        <label className="dc-field">
          <span>Expires (optional)</span>
          <input type="datetime-local" name="expiresAt" />
        </label>
      </div>
      <label className="dc-field">
        <span>Rationale (optional)</span>
        <input type="text" name="rationale" placeholder="Source / context for this signal" />
      </label>
      {error && (
        <p role="alert" className="dc-status-tag dc-status-suspended">
          {error}
        </p>
      )}
      <div className="dc-filter-actions">
        <button type="submit" className="dc-button-primary" disabled={submitting}>
          {submitting ? "Logging…" : "Log signal"}
        </button>
      </div>
    </form>
  );
}
