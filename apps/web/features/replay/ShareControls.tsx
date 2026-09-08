"use client";

import { useRef, useState } from "react";

/**
 * Owner share controls for completed results (Phase 3E2 M5, ADR 0016 R4).
 *
 * Creates/rotates or revokes the private read-only link. The raw share URL
 * is rendered exactly once after creation for the owner to copy — it is
 * never stored client-side beyond this component's state and never logged.
 * Focus moves to the result status after each action; copy feedback is
 * announced via a polite live region.
 */

export function ShareControls({ draftId }: { draftId: string }): React.JSX.Element {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [rotated, setRotated] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);

  async function createShare(): Promise<void> {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const response = await fetch(`/api/v1/drafts/${draftId}/share`, { method: "POST" });
      const body = (await response.json()) as {
        data?: { shareUrl?: string; expiresAt?: string; rotated?: boolean };
        error?: { detail?: string };
      };
      if (!response.ok || !body.data?.shareUrl) {
        throw new Error(
          body.error?.detail ?? `Share creation failed (${String(response.status)}).`,
        );
      }
      setShareUrl(body.data.shareUrl);
      setExpiresAt(body.data.expiresAt ?? null);
      setRotated(body.data.rotated ?? false);
      setStatus(
        body.data.rotated
          ? "A new private link was created. The previous link no longer works."
          : "A private read-only link was created. Only people with this link can view the result.",
      );
      statusRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Share creation failed.");
      statusRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function revokeShare(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/drafts/${draftId}/share`, { method: "DELETE" });
      const body = (await response.json()) as {
        data?: { revoked?: boolean };
        error?: { detail?: string };
      };
      if (!response.ok) {
        throw new Error(body.error?.detail ?? `Revocation failed (${String(response.status)}).`);
      }
      setShareUrl(null);
      setExpiresAt(null);
      setStatus(
        body.data?.revoked
          ? "The private link was revoked immediately. It no longer opens the result."
          : "There is no active private link for this draft.",
      );
      statusRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revocation failed.");
      statusRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(): Promise<void> {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      setCopied(false);
      setError("Copy failed — select the link text manually.");
    }
  }

  return (
    <section aria-labelledby="share-heading" className="dc-share-section">
      <h2 id="share-heading">Private result sharing</h2>
      <p className="dc-hint">
        Share a read-only result link. Links expire 90 days after creation and can be revoked at any
        time. Only completed drafts can be shared.
      </p>
      <div className="dc-share-actions">
        <button
          type="button"
          className="dc-button-primary"
          disabled={busy}
          onClick={() => {
            void createShare();
          }}
        >
          {shareUrl || rotated ? "Create new link" : "Create private link"}
        </button>
        <button
          type="button"
          className="dc-button-secondary"
          disabled={busy}
          onClick={() => {
            void revokeShare();
          }}
        >
          Revoke link
        </button>
      </div>
      <p ref={statusRef} tabIndex={-1} aria-live="polite" className="dc-share-status">
        {status ?? ""}
      </p>
      {error && (
        <div role="alert" className="dc-replay-error">
          <p>{error}</p>
        </div>
      )}
      {shareUrl && (
        <div className="dc-share-result">
          <label htmlFor="dc-share-url">Private link (shown once — copy it now)</label>
          <div className="dc-share-url-row">
            <input
              id="dc-share-url"
              type="text"
              readOnly
              value={shareUrl}
              autoComplete="off"
              spellCheck={false}
              onFocus={(event) => {
                event.target.select();
              }}
            />
            <button
              type="button"
              className="dc-button-secondary"
              onClick={() => {
                void copyLink();
              }}
            >
              Copy link
            </button>
          </div>
          <p aria-live="polite" className="dc-hint">
            {copied ? "Link copied to clipboard." : ""}
            {expiresAt ? ` Expires ${new Date(expiresAt).toLocaleString()}.` : ""}
          </p>
        </div>
      )}
    </section>
  );
}
