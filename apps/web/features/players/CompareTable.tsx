import Link from "next/link";
import { PlayerAvatar } from "@/features/players/PlayerAvatar";
import type { PublicPlayerProfile } from "@/lib/server/player-profile";

interface StatRow {
  key: string;
  label: string;
  /** Whether the highest value in this row is marked as the category
   * leader. A neutral factual marker ("highest"), never phrased as
   * "better" — a higher turnover count is still marked, for example. */
  highlightLeader: boolean;
  get: (profile: PublicPlayerProfile) => number | null;
  format: (value: number | null) => string;
}

function fmt(value: number | null, digits = 1): string {
  return value === null ? "—" : value.toFixed(digits);
}

function pctFmt(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function scoreFmt(value: number | null): string {
  return value === null ? "—" : `${String(Math.round(value * 100))}%`;
}

const STAT_ROWS: StatRow[] = [
  {
    key: "games",
    label: "Games",
    highlightLeader: true,
    get: (p) => p.projection.games,
    format: (v) => fmt(v, 0),
  },
  {
    key: "minutesPerGame",
    label: "MPG",
    highlightLeader: true,
    get: (p) => p.projection.minutesPerGame,
    format: fmt,
  },
  { key: "pts", label: "PTS", highlightLeader: true, get: (p) => p.projection.pts, format: fmt },
  { key: "reb", label: "REB", highlightLeader: true, get: (p) => p.projection.reb, format: fmt },
  { key: "ast", label: "AST", highlightLeader: true, get: (p) => p.projection.ast, format: fmt },
  { key: "stl", label: "STL", highlightLeader: true, get: (p) => p.projection.stl, format: fmt },
  { key: "blk", label: "BLK", highlightLeader: true, get: (p) => p.projection.blk, format: fmt },
  { key: "tov", label: "TOV", highlightLeader: true, get: (p) => p.projection.tov, format: fmt },
  {
    key: "fgPct",
    label: "FG%",
    highlightLeader: true,
    get: (p) => p.projection.fgPct,
    format: pctFmt,
  },
  {
    key: "ftPct",
    label: "FT%",
    highlightLeader: true,
    get: (p) => p.projection.ftPct,
    format: pctFmt,
  },
  {
    key: "threePm",
    label: "3PM",
    highlightLeader: true,
    get: (p) => p.projection.threePm,
    format: fmt,
  },
  {
    key: "fantasyPoints",
    label: "Fantasy pts",
    highlightLeader: true,
    get: (p) => p.projection.fantasyPoints,
    format: fmt,
  },
  {
    key: "overallRank",
    label: "Internal rank",
    highlightLeader: false,
    get: (p) => p.projection.overallRank,
    format: (v) => (v === null ? "—" : `#${String(v)}`),
  },
  {
    key: "adp",
    label: "Demo ADP",
    highlightLeader: false,
    get: (p) => (p.adp ? p.adp.consensusAdp : null),
    format: fmt,
  },
  {
    key: "injuryRisk",
    label: "Injury risk",
    highlightLeader: false,
    get: (p) => p.projection.injuryRisk,
    format: scoreFmt,
  },
  {
    key: "consistency",
    label: "Consistency",
    highlightLeader: false,
    get: (p) => p.projection.consistency,
    format: scoreFmt,
  },
  {
    key: "upside",
    label: "Upside",
    highlightLeader: false,
    get: (p) => p.projection.upside,
    format: scoreFmt,
  },
  {
    key: "roleSecurity",
    label: "Role security",
    highlightLeader: false,
    get: (p) => p.projection.roleSecurity,
    format: scoreFmt,
  },
];

function leaderIndexes(values: (number | null)[]): Set<number> {
  const numeric = values.filter((v): v is number => v !== null);
  if (numeric.length < 2) return new Set();
  const max = Math.max(...numeric);
  const indexes = new Set<number>();
  values.forEach((v, i) => {
    if (v === max) indexes.add(i);
  });
  return indexes;
}

export function CompareTable({ profiles }: { profiles: PublicPlayerProfile[] }) {
  return (
    <div
      className="dc-data-table-scroll"
      role="region"
      aria-label="Player comparison table"
      tabIndex={0}
    >
      <table className="dc-data-table dc-compare-table">
        <caption className="dc-visually-hidden">
          Baseline projection comparison for {profiles.map((p) => p.displayName).join(", ")}. The
          highest value in each row is marked as the category leader — this is a factual marker, not
          a recommendation.
        </caption>
        <thead>
          <tr>
            <th scope="col">Stat</th>
            {profiles.map((profile) => (
              <th scope="col" key={profile.id}>
                <Link href={`/players/${profile.slug}`} className="dc-player-link">
                  <PlayerAvatar
                    name={profile.displayName}
                    team={profile.team}
                    size="sm"
                    decorative
                  />
                  <span>
                    {profile.displayName}
                    <div className="dc-compare-header-meta">
                      {profile.team?.abbreviation ?? "FA"} · {profile.positions.join("/") || "—"}
                    </div>
                  </span>
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {STAT_ROWS.map((row) => {
            const values = profiles.map((p) => row.get(p));
            const leaders = row.highlightLeader ? leaderIndexes(values) : new Set<number>();
            return (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                {values.map((value, index) => (
                  <td
                    key={profiles[index]?.id ?? index}
                    className={[
                      "dc-numeric",
                      "dc-tabular",
                      leaders.has(index) && "dc-compare-leader",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {row.format(value)}
                    {leaders.has(index) && (
                      <span className="dc-visually-hidden"> (highest in this row)</span>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
