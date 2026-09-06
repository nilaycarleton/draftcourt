"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { HistoryCard } from "./HistoryCard";
import {
  HistoryFilters,
  type HistoryFiltersValue,
  type HistoryLeagueOption,
} from "./HistoryFilters";

export interface HistoryWorkspaceItem {
  id: string;
  leagueName: string;
  season?: string | undefined;
  type: "REAL" | "MOCK" | "DEMO";
  status: "SETUP" | "ACTIVE" | "PAUSED" | "COMPLETED" | "ABANDONED";
  updatedAt: string;
  grade?: string | null | undefined;
  gradeScore?: number | null | undefined;
  summary?: string | undefined;
  hasAnalysis?: boolean | undefined;
}

export interface HistoryWorkspaceProps {
  items: HistoryWorkspaceItem[];
  leagues?: HistoryLeagueOption[] | undefined;
  nextCursor?: string | null | undefined;
  isLoading?: boolean | undefined;
  error?: string | null | undefined;
  onLoadMore?: ((cursor: string) => void) | undefined;
  onRetry?: (() => void) | undefined;
  totalCount?: number | undefined;
}

/**
 * Isolated history workspace (Phase 3E1).
 *
 * Owns the single aria-live="polite" for the page, correct heading
 * sequence (h1 → h2 for sections), skeleton/empty/error states, cursor
 * pagination, 320px reflow, and focus-visible. No server coupling – all
 * data arrives via props so the workspace stays pure and previewable.
 */
export function HistoryWorkspace({
  items,
  leagues = [],
  nextCursor = null,
  isLoading = false,
  error = null,
  onLoadMore,
  onRetry,
  totalCount,
}: HistoryWorkspaceProps): React.JSX.Element {
  const [filters, setFilters] = useState<HistoryFiltersValue>({
    type: "ALL",
    status: "ALL",
    leagueId: null,
    from: null,
    to: null,
  });

  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (filters.type !== "ALL" && item.type !== filters.type) return false;
      if (filters.status !== "ALL" && item.status !== filters.status) return false;
      if (
        filters.leagueId !== null &&
        !item.leagueName.toLowerCase().includes(filters.leagueId.toLowerCase())
      ) {
        // When leagues are not joined, fallback: no filtering. Caller can
        // pre-filter server-side; this is a best-effort client filter that
        // matches the `leagueId` shape when the option id equals leagueName
        // in fixtures. Real filtering is server-side – this preserves story
        // interactivity without requiring the API here.
        // We treat leagueId as opaque; if no leagueName matches id, hide.
        // For fixture parity, check id equality against a synthetic field.
        // Since we only have leagueName, we simply require exact match when
        // leagues are unknown – otherwise defer to server.
        if (leagues.length > 0) {
          const league = leagues.find((l) => l.id === filters.leagueId);
          if (league && item.leagueName !== league.name) return false;
        }
      }
      if (filters.from !== null) {
        const from = new Date(filters.from);
        const updated = new Date(item.updatedAt);
        if (!Number.isNaN(from.getTime()) && !Number.isNaN(updated.getTime()) && updated < from)
          return false;
      }
      if (filters.to !== null) {
        const to = new Date(filters.to);
        const updated = new Date(item.updatedAt);
        if (!Number.isNaN(to.getTime()) && !Number.isNaN(updated.getTime()) && updated > to)
          return false;
      }
      return true;
    });
  }, [filters, items, leagues]);

  const count = totalCount ?? filtered.length;
  const announcement = isLoading
    ? "Loading drafts…"
    : error
      ? `Error: ${error}`
      : count === 0
        ? "No drafts match your filters."
        : `${String(count)} ${count === 1 ? "draft" : "drafts"} found.`;

  return (
    <div className="dc-history-workspace">
      {/* Single polite live region for the page – count + loading + errors */}
      <div aria-live="polite" className="dc-visually-hidden">
        {announcement}
      </div>

      <header className="dc-page-header">
        <h1>Draft history</h1>
        <p className="dc-page-subtitle">
          Real and mock drafts you’ve saved. Mock and real drafts are shown; demo drafts are not
          included.
        </p>
      </header>

      <HistoryFilters value={filters} leagues={leagues} onChange={setFilters} resultCount={count} />

      {error && (
        <div role="alert" className="dc-history-error">
          <p>{error}</p>
          {onRetry && (
            <button type="button" className="dc-history-retry" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}

      {isLoading && filtered.length === 0 ? (
        <ul className="dc-history-skeleton" aria-label="Loading history">
          {Array.from({ length: 3 }, (_, index) => (
            <li key={index} className="dc-history-skeleton-card" aria-hidden="true">
              <div className="dc-history-skeleton-line dc-history-skeleton-line-title" />
              <div className="dc-history-skeleton-line" />
              <div className="dc-history-skeleton-line dc-history-skeleton-line-short" />
            </li>
          ))}
        </ul>
      ) : filtered.length === 0 ? (
        <div className="dc-history-empty" role="status">
          <h2>No drafts yet</h2>
          <p>
            Start a real draft or run a mock to see it here. Demo drafts don’t appear in history.
          </p>
          <Link href="/drafts/new" className="dc-history-empty-action">
            Start a draft
          </Link>
        </div>
      ) : (
        <>
          <ul className="dc-history-list" aria-label="Draft history">
            {filtered.map((item) => (
              <li key={item.id}>
                <HistoryCard
                  id={item.id}
                  leagueName={item.leagueName}
                  season={item.season}
                  type={item.type}
                  status={item.status}
                  updatedAt={item.updatedAt}
                  grade={item.grade}
                  gradeScore={item.gradeScore}
                  summary={item.summary}
                  hasAnalysis={item.hasAnalysis}
                />
              </li>
            ))}
          </ul>

          {nextCursor && onLoadMore && (
            <button
              type="button"
              className="dc-history-load-more"
              disabled={isLoading}
              onClick={() => {
                onLoadMore(nextCursor);
              }}
            >
              {isLoading ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
