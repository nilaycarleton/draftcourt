import Link from "next/link";
import type { PlayersQuery } from "@/lib/server/players-query";

/**
 * A plain `<form method="get">` — filter state lives entirely in the URL
 * (BUILD_SPEC.md section 9.3: "Filter state belongs in the URL") and the
 * whole form works with JavaScript disabled: submitting navigates to
 * `/players?...` and the Server Component page re-renders with the new
 * filters. No client-side state management needed for the primary path.
 */

const POSITIONS = ["PG", "SG", "SF", "PF", "C"] as const;
const AVAILABILITY = ["ACTIVE", "INJURED", "SUSPENDED", "UNSIGNED", "RETIRED"] as const;
const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "overallRank", label: "Internal rank" },
  { value: "fantasyPoints", label: "Fantasy points" },
  { value: "adp", label: "ADP" },
  { value: "pts", label: "Points" },
  { value: "reb", label: "Rebounds" },
  { value: "ast", label: "Assists" },
  { value: "displayName", label: "Name" },
];

function val(v: number | undefined): string {
  return v === undefined ? "" : String(v);
}

export function PlayerFilterForm({ query }: { query: PlayersQuery }) {
  return (
    <form method="get" action="/players" className="dc-filter-form" aria-label="Filter players">
      <div className="dc-filter-row">
        <label className="dc-field">
          <span>Search</span>
          <input
            type="search"
            name="name"
            defaultValue={query.name ?? ""}
            placeholder="Player name"
          />
        </label>

        <label className="dc-field">
          <span>Position</span>
          <select name="position" defaultValue={query.position?.[0] ?? ""}>
            <option value="">Any</option>
            {POSITIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        <label className="dc-field">
          <span>Availability</span>
          <select name="availability" defaultValue={query.availability?.[0] ?? ""}>
            <option value="">Any</option>
            {AVAILABILITY.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>

        <label className="dc-field dc-field-checkbox">
          <input
            type="checkbox"
            name="unsigned"
            value="true"
            defaultChecked={query.unsigned === true}
          />
          <span>Unsigned only</span>
        </label>

        <label className="dc-field dc-field-checkbox">
          <input
            type="checkbox"
            name="rookie"
            value="true"
            defaultChecked={query.rookie === true}
          />
          <span>Rookies only</span>
        </label>

        <label className="dc-field">
          <span>Sort by</span>
          <select name="sort" defaultValue={query.sort}>
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="dc-field">
          <span>Direction</span>
          <select name="direction" defaultValue={query.direction}>
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </label>
      </div>

      <details className="dc-filter-advanced">
        <summary>More filters</summary>
        <div className="dc-filter-row">
          <label className="dc-field">
            <span>Age min</span>
            <input type="number" name="ageMin" min={18} max={45} defaultValue={val(query.ageMin)} />
          </label>
          <label className="dc-field">
            <span>Age max</span>
            <input type="number" name="ageMax" min={18} max={45} defaultValue={val(query.ageMax)} />
          </label>
          <label className="dc-field">
            <span>ADP min</span>
            <input type="number" name="adpMin" min={1} defaultValue={val(query.adpMin)} />
          </label>
          <label className="dc-field">
            <span>ADP max</span>
            <input type="number" name="adpMax" min={1} defaultValue={val(query.adpMax)} />
          </label>
          <label className="dc-field">
            <span>Rank min</span>
            <input type="number" name="rankMin" min={1} defaultValue={val(query.rankMin)} />
          </label>
          <label className="dc-field">
            <span>Rank max</span>
            <input type="number" name="rankMax" min={1} defaultValue={val(query.rankMax)} />
          </label>
          <label className="dc-field">
            <span>Min projected games</span>
            <input
              type="number"
              name="gamesMin"
              min={0}
              max={82}
              defaultValue={val(query.gamesMin)}
            />
          </label>
          <label className="dc-field">
            <span>Min projected minutes</span>
            <input
              type="number"
              name="minutesMin"
              min={0}
              max={48}
              defaultValue={val(query.minutesMin)}
            />
          </label>
          <label className="dc-field">
            <span>Min fantasy points</span>
            <input
              type="number"
              name="fantasyPointsMin"
              defaultValue={val(query.fantasyPointsMin)}
            />
          </label>
          <label className="dc-field">
            <span>Max injury risk</span>
            <input
              type="number"
              name="injuryRiskMax"
              min={0}
              max={1}
              step={0.05}
              defaultValue={val(query.injuryRiskMax)}
            />
          </label>
          <label className="dc-field">
            <span>Min consistency</span>
            <input
              type="number"
              name="consistencyMin"
              min={0}
              max={1}
              step={0.05}
              defaultValue={val(query.consistencyMin)}
            />
          </label>
          <label className="dc-field">
            <span>Min upside</span>
            <input
              type="number"
              name="upsideMin"
              min={0}
              max={1}
              step={0.05}
              defaultValue={val(query.upsideMin)}
            />
          </label>
          <label className="dc-field">
            <span>Min role security</span>
            <input
              type="number"
              name="roleSecurityMin"
              min={0}
              max={1}
              step={0.05}
              defaultValue={val(query.roleSecurityMin)}
            />
          </label>
        </div>
      </details>

      <div className="dc-filter-actions">
        <button type="submit" className="dc-button-primary">
          Apply filters
        </button>
        <Link href="/players" className="dc-button-ghost">
          Clear all
        </Link>
      </div>
    </form>
  );
}
