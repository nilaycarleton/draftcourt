"use client";

export type HistoryFilterType = "ALL" | "REAL" | "MOCK";
export type HistoryFilterStatus = "ALL" | "SETUP" | "ACTIVE" | "PAUSED" | "COMPLETED" | "ABANDONED";

export interface HistoryLeagueOption {
  id: string;
  name: string;
}

export interface HistoryFiltersValue {
  type: HistoryFilterType;
  status: HistoryFilterStatus;
  leagueId: string | null;
  from: string | null; // YYYY-MM-DD
  to: string | null;
}

export interface HistoryFiltersProps {
  value: HistoryFiltersValue;
  leagues?: HistoryLeagueOption[] | undefined;
  onChange: (next: HistoryFiltersValue) => void;
  resultCount?: number | undefined;
}

/**
 * Isolated history filter bar (Phase 3E1).
 *
 * Token-only, 44px targets, flex-wrap down to 320px, keyboard-accessible
 * native selects/inputs, and no color-only meaning. Every control has a
 * visible label linked via htmlFor/id, and the result count is announced
 * via the workspace's single polite live region – not duplicated here.
 */
export function HistoryFilters({
  value,
  leagues = [],
  onChange,
  resultCount,
}: HistoryFiltersProps): React.JSX.Element {
  return (
    <section className="dc-history-filters" aria-label="History filters">
      <div className="dc-history-filters-row">
        <label className="dc-history-filter-field" htmlFor="history-filter-type">
          <span>Type</span>
          <select
            id="history-filter-type"
            value={value.type}
            onChange={(event) => {
              onChange({ ...value, type: event.target.value as HistoryFilterType });
            }}
          >
            <option value="ALL">All types</option>
            <option value="REAL">Real</option>
            <option value="MOCK">Mock</option>
          </select>
        </label>

        <label className="dc-history-filter-field" htmlFor="history-filter-status">
          <span>Status</span>
          <select
            id="history-filter-status"
            value={value.status}
            onChange={(event) => {
              onChange({ ...value, status: event.target.value as HistoryFilterStatus });
            }}
          >
            <option value="ALL">All statuses</option>
            <option value="SETUP">Setup</option>
            <option value="ACTIVE">Active</option>
            <option value="PAUSED">Paused</option>
            <option value="COMPLETED">Completed</option>
            <option value="ABANDONED">Abandoned</option>
          </select>
        </label>

        <label className="dc-history-filter-field" htmlFor="history-filter-league">
          <span>League</span>
          <select
            id="history-filter-league"
            value={value.leagueId ?? ""}
            onChange={(event) => {
              onChange({ ...value, leagueId: event.target.value || null });
            }}
          >
            <option value="">All leagues</option>
            {leagues.map((league) => (
              <option key={league.id} value={league.id}>
                {league.name}
              </option>
            ))}
          </select>
        </label>

        <label className="dc-history-filter-field" htmlFor="history-filter-from">
          <span>From</span>
          <input
            id="history-filter-from"
            type="date"
            value={value.from ?? ""}
            onChange={(event) => {
              onChange({ ...value, from: event.target.value || null });
            }}
          />
        </label>

        <label className="dc-history-filter-field" htmlFor="history-filter-to">
          <span>To</span>
          <input
            id="history-filter-to"
            type="date"
            value={value.to ?? ""}
            onChange={(event) => {
              onChange({ ...value, to: event.target.value || null });
            }}
          />
        </label>

        <button
          type="button"
          className="dc-history-filter-reset"
          onClick={() => {
            onChange({ type: "ALL", status: "ALL", leagueId: null, from: null, to: null });
          }}
        >
          Reset filters
        </button>
      </div>

      {typeof resultCount === "number" && (
        <p className="dc-history-filter-count" aria-hidden="true">
          {resultCount === 0
            ? "No drafts match your filters."
            : `${String(resultCount)} ${resultCount === 1 ? "draft" : "drafts"} found.`}
        </p>
      )}
    </section>
  );
}
