import { ScoreBar, Sparkline } from "@draftcourt/ui";
import type { SparklinePoint } from "@draftcourt/ui";
import { PlayerAvatar } from "@/features/players/PlayerAvatar";
import type { PublicPlayerProfile } from "@/lib/server/player-profile";

const STAT_LABELS: Record<string, string> = {
  pts: "Points",
  reb: "Rebounds",
  ast: "Assists",
  stl: "Steals",
  blk: "Blocks",
  threePm: "Three-pointers made",
};

function fmt(value: number | null, digits = 1): string {
  return value === null ? "—" : value.toFixed(digits);
}

function pctFmt(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function intervalFmt(record: Record<string, number>, key: string): string {
  const value = record[key];
  return typeof value === "number" ? fmt(value) : "—";
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="dc-stat-card">
      <span className="dc-stat-card-label">{label}</span>
      <span className="dc-stat-card-value dc-tabular">{value}</span>
      {sub && <span className="dc-stat-card-sub">{sub}</span>}
    </div>
  );
}

function StatusBadges({ profile }: { profile: PublicPlayerProfile }) {
  return (
    <div className="dc-badge-row">
      {profile.status !== "ACTIVE" && (
        <span className={`dc-status-tag dc-status-${profile.status.toLowerCase()}`}>
          {profile.status}
        </span>
      )}
      {profile.unsigned && <span className="dc-status-tag dc-status-unsigned">UNSIGNED</span>}
      {profile.rookie && <span className="dc-status-tag dc-status-rookie">ROOKIE</span>}
    </div>
  );
}

export function PlayerProfile({ profile }: { profile: PublicPlayerProfile }) {
  const { projection } = profile;
  const trendPoints: SparklinePoint[] = [
    ...profile.historicalSeasons.map((s) => ({ label: s.season, value: s.pts })),
    ...(profile.projectionRun ? [{ label: "Proj.", value: projection.pts }] : []),
  ];

  return (
    <>
      <header className="dc-profile-header">
        <PlayerAvatar name={profile.displayName} team={profile.team} size="lg" decorative />
        <div className="dc-profile-heading">
          <h1>{profile.displayName}</h1>
          <p className="dc-profile-meta">
            {profile.team?.name ?? "Free agent"} · {profile.positions.join("/") || "—"} ·{" "}
            {profile.age !== null ? `Age ${String(Math.floor(profile.age))}` : "Age unknown"} ·
            Internal rank #{projection.overallRank || "—"}
          </p>
          <StatusBadges profile={profile} />
        </div>
      </header>

      <div className="dc-demo-banner" role="note">
        <strong>DEMO — SYNTHETIC DATA.</strong> {profile.displayName}&apos;s name, team, and
        position are real; every statistic and projection below is fabricated for demonstration. See{" "}
        <a href="/data-sources">data sources</a> and <a href="/methodology">methodology</a>.
      </div>

      <section className="dc-profile-section" aria-labelledby="projected-heading">
        <h2 id="projected-heading">Baseline projection</h2>
        <div className="dc-stat-grid">
          <StatCard label="Fantasy pts" value={fmt(projection.fantasyPoints)} />
          <StatCard label="Games" value={fmt(projection.games, 0)} />
          <StatCard label="MPG" value={fmt(projection.minutesPerGame)} />
          <StatCard label="PTS" value={fmt(projection.pts)} />
          <StatCard label="REB" value={fmt(projection.reb)} />
          <StatCard label="AST" value={fmt(projection.ast)} />
          <StatCard label="STL" value={fmt(projection.stl)} />
          <StatCard label="BLK" value={fmt(projection.blk)} />
          <StatCard label="TOV" value={fmt(projection.tov)} />
          <StatCard label="FG%" value={pctFmt(projection.fgPct)} />
          <StatCard label="FT%" value={pctFmt(projection.ftPct)} />
          <StatCard label="3PM" value={fmt(projection.threePm)} />
        </div>
        {Object.keys(projection.lower80).length > 0 && (
          <p className="dc-interval-note">
            80% projection interval — points per game: {intervalFmt(projection.lower80, "pts")} –{" "}
            {intervalFmt(projection.upper80, "pts")}. Heuristic bounds, not a statistically
            calibrated model; see <a href="/methodology">methodology</a>.
          </p>
        )}
        {profile.adp && (
          <p className="dc-interval-note">
            Demo consensus ADP {fmt(profile.adp.consensusAdp)} from {profile.adp.sourcesCount} demo
            source{profile.adp.sourcesCount === 1 ? "" : "s"}
            {profile.adpDelta !== null &&
              ` — internal rank is ${String(Math.abs(profile.adpDelta))} spot${Math.abs(profile.adpDelta) === 1 ? "" : "s"} ${profile.adpDelta < 0 ? "ahead of" : "behind"} demo ADP.`}
          </p>
        )}
      </section>

      <section className="dc-profile-section" aria-labelledby="indicators-heading">
        <h2 id="indicators-heading">Risk &amp; role indicators</h2>
        <div className="dc-score-bar-grid">
          <ScoreBar label="Injury risk" value={projection.injuryRisk} invert />
          <ScoreBar label="Consistency" value={projection.consistency} />
          <ScoreBar label="Upside" value={projection.upside} />
          <ScoreBar label="Role security" value={projection.roleSecurity} />
        </div>
      </section>

      {(profile.strengths.length > 0 || profile.weaknesses.length > 0) && (
        <section className="dc-profile-section" aria-labelledby="sw-heading">
          <h2 id="sw-heading">Heuristic strengths &amp; weaknesses</h2>
          <p className="dc-profile-note">
            Categories where this player is notably above or below the current player pool&apos;s
            average — a simple statistical comparison, not DraftCourt&apos;s roster-aware
            recommendation engine (that arrives in the live-draft phase).
          </p>
          <div className="dc-badge-row">
            {profile.strengths.map((stat) => (
              <span key={stat} className="dc-status-tag dc-status-rookie">
                {STAT_LABELS[stat] ?? stat}
              </span>
            ))}
            {profile.weaknesses.map((stat) => (
              <span key={stat} className="dc-status-tag dc-status-suspended">
                {STAT_LABELS[stat] ?? stat}
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="dc-profile-section" aria-labelledby="trend-heading">
        <h2 id="trend-heading">Points trend</h2>
        {trendPoints.length > 0 ? (
          <div className="dc-trend-row">
            <Sparkline points={trendPoints} width={240} height={56} />
          </div>
        ) : (
          <p className="dc-profile-note">No historical seasons on file.</p>
        )}
        <div
          className="dc-data-table-scroll"
          role="region"
          aria-label={`${profile.displayName}'s per-game stats by season`}
          tabIndex={0}
        >
          <table className="dc-data-table">
            <caption className="dc-visually-hidden">
              {profile.displayName}&apos;s per-game stats by season, historical and projected
            </caption>
            <thead>
              <tr>
                <th scope="col">Season</th>
                <th scope="col">Scope</th>
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
              </tr>
            </thead>
            <tbody>
              {profile.historicalSeasons.map((season) => (
                <tr key={`${season.season}-${season.scope}`}>
                  <td>{season.season}</td>
                  <td>{season.scope}</td>
                  <td className="dc-numeric dc-tabular">{fmt(season.gamesPlayed, 0)}</td>
                  <td className="dc-numeric dc-tabular">{fmt(season.minutesPerGame)}</td>
                  <td className="dc-numeric dc-tabular">{fmt(season.pts)}</td>
                  <td className="dc-numeric dc-tabular">{fmt(season.reb)}</td>
                  <td className="dc-numeric dc-tabular">{fmt(season.ast)}</td>
                  <td className="dc-numeric dc-tabular">{pctFmt(season.fgPct)}</td>
                  <td className="dc-numeric dc-tabular">{pctFmt(season.ftPct)}</td>
                </tr>
              ))}
              {profile.projectionRun && (
                <tr>
                  <td>
                    <strong>Projected</strong>
                  </td>
                  <td>NBA</td>
                  <td className="dc-numeric dc-tabular">{fmt(projection.games, 0)}</td>
                  <td className="dc-numeric dc-tabular">{fmt(projection.minutesPerGame)}</td>
                  <td className="dc-numeric dc-tabular">{fmt(projection.pts)}</td>
                  <td className="dc-numeric dc-tabular">{fmt(projection.reb)}</td>
                  <td className="dc-numeric dc-tabular">{fmt(projection.ast)}</td>
                  <td className="dc-numeric dc-tabular">{pctFmt(projection.fgPct)}</td>
                  <td className="dc-numeric dc-tabular">{pctFmt(projection.ftPct)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="dc-profile-section" aria-labelledby="methodology-heading">
        <h2 id="methodology-heading">How this baseline was produced</h2>
        <p className="dc-profile-note">
          DraftCourt&apos;s baseline model weights a player&apos;s recent seasons (most recent
          weighted heaviest), then adjusts for age, injury history, and role signals. Rookies and
          players without an NBA season on file fall back to a college-translation estimate.
          Shooting percentages are always derived from projected makes and attempts, never averaged
          directly. This is a deterministic statistical baseline, not a machine-learning model —
          read the full methodology, including its limitations, at{" "}
          <a href="/methodology">/methodology</a>.
        </p>
        <p className="dc-profile-note dc-draft-phase-note">
          <strong>This page shows the standalone baseline projection only.</strong> Roster-aware,
          draft-context recommendations (who to pick given your league settings and the players
          already off the board) are not part of Phase 1 — they arrive in the live-draft phase.
        </p>
      </section>

      {profile.projectionRun && (
        <p className="dc-freshness-note dc-profile-footer">
          Model {profile.projectionRun.modelVersion} · run {profile.projectionRun.runId} ·
          projection cutoff {new Date(profile.projectionRun.dataCutoff).toLocaleDateString()}
        </p>
      )}
    </>
  );
}
