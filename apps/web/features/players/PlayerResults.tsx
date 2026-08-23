import { DeltaChip } from "@draftcourt/ui";
import { PlayerAvatar } from "@/features/players/PlayerAvatar";
import Link from "next/link";
import { decodeCursor, encodeCursor } from "@/lib/server/players";
import type { PlayerListResult, PublicPlayerSummary } from "@/lib/server/players";
import type { PlayersQuery } from "@/lib/server/players-query";

function buildHref(query: PlayersQuery, overrides: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...query, ...overrides })) {
    if (value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(","));
    } else {
      params.set(key, String(value));
    }
  }
  return `/players?${params.toString()}`;
}

function StatusBadges({ player }: { player: PublicPlayerSummary }) {
  return (
    <div className="dc-badge-row">
      {player.status !== "ACTIVE" && (
        <span className={`dc-status-tag dc-status-${player.status.toLowerCase()}`}>
          {player.status}
        </span>
      )}
      {player.unsigned && <span className="dc-status-tag dc-status-unsigned">UNSIGNED</span>}
      {player.rookie && <span className="dc-status-tag dc-status-rookie">ROOKIE</span>}
    </div>
  );
}

function fmt(value: number | null, digits = 1): string {
  return value === null ? "—" : value.toFixed(digits);
}

function pctFmt(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function PlayerResults({
  result,
  query,
}: {
  result: PlayerListResult;
  query: PlayersQuery;
}) {
  const currentOffset = decodeCursor(query.cursor) ?? 0;
  const prevOffset = Math.max(0, currentOffset - query.limit);
  const hasPrev = currentOffset > 0;

  return (
    <section aria-label="Player results">
      <p aria-live="polite" className="dc-visually-hidden">
        {result.totalCount} players found.
      </p>
      <div className="dc-results-summary">
        <span>
          {result.totalCount} player{result.totalCount === 1 ? "" : "s"}
        </span>
        {result.meta.dataCutoff && (
          <span className="dc-freshness-note">
            Projection cutoff {new Date(result.meta.dataCutoff).toLocaleDateString()} · model{" "}
            {result.meta.modelVersion}
          </span>
        )}
      </div>

      {result.players.length === 0 ? (
        <div className="dc-empty-state" role="status">
          <p>No players match these filters.</p>
          <Link href="/players">Clear filters</Link>
        </div>
      ) : (
        <>
          <div
            className="dc-data-table-scroll dc-players-table-desktop"
            role="region"
            aria-label="Player results table"
            tabIndex={0}
          >
            <table className="dc-data-table">
              <caption className="dc-visually-hidden">
                Player projections sorted by {query.sort}, {query.direction}ending
              </caption>
              <thead>
                <tr>
                  <th scope="col">Rank</th>
                  <th scope="col">Player</th>
                  <th scope="col">Team</th>
                  <th scope="col">Pos</th>
                  <th scope="col" className="dc-numeric">
                    GP
                  </th>
                  <th scope="col" className="dc-numeric">
                    MPG
                  </th>
                  <th scope="col" className="dc-numeric">
                    PTS
                  </th>
                  <th scope="col" className="dc-numeric">
                    REB
                  </th>
                  <th scope="col" className="dc-numeric">
                    AST
                  </th>
                  <th scope="col" className="dc-numeric">
                    FG%
                  </th>
                  <th scope="col" className="dc-numeric">
                    FT%
                  </th>
                  <th scope="col" className="dc-numeric">
                    3PM
                  </th>
                  <th scope="col" className="dc-numeric">
                    Fantasy pts
                  </th>
                  <th scope="col" className="dc-numeric">
                    Demo ADP
                  </th>
                  <th scope="col" className="dc-numeric">
                    Value
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.players.map((player) => (
                  <tr key={player.id}>
                    <td className="dc-numeric dc-tabular">{player.projection.overallRank}</td>
                    <td>
                      <Link href={`/players/${player.slug}`} className="dc-player-link">
                        <PlayerAvatar
                          name={player.displayName}
                          team={player.team}
                          size="sm"
                          decorative
                        />
                        <span>
                          {player.displayName}
                          <StatusBadges player={player} />
                        </span>
                      </Link>
                    </td>
                    <td>{player.team?.abbreviation ?? "FA"}</td>
                    <td>{player.positions.join("/")}</td>
                    <td className="dc-numeric dc-tabular">{fmt(player.projection.games, 0)}</td>
                    <td className="dc-numeric dc-tabular">
                      {fmt(player.projection.minutesPerGame)}
                    </td>
                    <td className="dc-numeric dc-tabular">{fmt(player.projection.pts)}</td>
                    <td className="dc-numeric dc-tabular">{fmt(player.projection.reb)}</td>
                    <td className="dc-numeric dc-tabular">{fmt(player.projection.ast)}</td>
                    <td className="dc-numeric dc-tabular">{pctFmt(player.projection.fgPct)}</td>
                    <td className="dc-numeric dc-tabular">{pctFmt(player.projection.ftPct)}</td>
                    <td className="dc-numeric dc-tabular">{fmt(player.projection.threePm)}</td>
                    <td className="dc-numeric dc-tabular">
                      {fmt(player.projection.fantasyPoints)}
                    </td>
                    <td className="dc-numeric dc-tabular">
                      {player.adp ? fmt(player.adp.consensusAdp) : "—"}
                    </td>
                    <td className="dc-numeric">
                      {player.adpDelta !== null && <DeltaChip delta={player.adpDelta} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="dc-players-cards-mobile" aria-hidden={false}>
            {result.players.map((player) => (
              <li key={player.id} className="dc-player-card">
                <Link href={`/players/${player.slug}`} className="dc-player-card-link">
                  <div className="dc-player-card-header">
                    <PlayerAvatar
                      name={player.displayName}
                      team={player.team}
                      size="md"
                      decorative
                    />
                    <div>
                      <div className="dc-player-card-name">{player.displayName}</div>
                      <div className="dc-player-card-meta">
                        {player.team?.abbreviation ?? "FA"} · {player.positions.join("/")} · Rank #
                        {player.projection.overallRank}
                      </div>
                      <StatusBadges player={player} />
                    </div>
                  </div>
                  <div className="dc-player-card-stats">
                    <span>
                      <strong className="dc-tabular">{fmt(player.projection.pts)}</strong> PTS
                    </span>
                    <span>
                      <strong className="dc-tabular">{fmt(player.projection.reb)}</strong> REB
                    </span>
                    <span>
                      <strong className="dc-tabular">{fmt(player.projection.ast)}</strong> AST
                    </span>
                    {player.adpDelta !== null && <DeltaChip delta={player.adpDelta} />}
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          <nav className="dc-pagination" aria-label="Pagination">
            {hasPrev ? (
              <Link href={buildHref(query, { cursor: encodeCursor(prevOffset) })}>← Previous</Link>
            ) : (
              <span aria-disabled="true" className="dc-pagination-disabled">
                ← Previous
              </span>
            )}
            {result.hasMore && result.nextCursor !== null ? (
              <Link href={buildHref(query, { cursor: encodeCursor(result.nextCursor) })}>
                Next →
              </Link>
            ) : (
              <span aria-disabled="true" className="dc-pagination-disabled">
                Next →
              </span>
            )}
          </nav>
        </>
      )}
    </section>
  );
}
