import { Sparkline, type SparklinePoint } from "./Sparkline";

export interface StandingDistributionPoint {
  /** Standing rank (1 = 1st). */
  standing: number;
  /** Probability 0..1 (or 0..100 – normalized internally). */
  probability: number;
  /** Optional label override. */
  label?: string | undefined;
}

export interface StandingDistributionProps {
  points: StandingDistributionPoint[];
  /** Precomputed p50 / median standing for the text summary. */
  p50?: number | null | undefined;
  /** Precomputed p90 / 90th percentile standing. */
  p90?: number | null | undefined;
  /** Total simulations used (e.g. 2000). Shown in caption/meta. */
  simulationCount?: number | undefined;
  headingId?: string | undefined;
  emptyMessage?: string | undefined;
}

function normalizeProbability(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > 1) return Math.max(0, Math.min(1, value / 100));
  return Math.max(0, Math.min(1, value));
}

/**
 * Projected standing distribution (Phase 3E1).
 *
 * Decorative Sparkline is aria-hidden; the accessible alternative is an
 * always-visible table with the same data plus a P50/P90 text summary and
 * a disclosure note about the replacement-built baseline. Token-only,
 * scroll-safe at 320px, and high-contrast friendly.
 */
export function StandingDistribution({
  points,
  p50,
  p90,
  simulationCount,
  headingId = "dc-standing-heading",
  emptyMessage = "No standing projection available.",
}: StandingDistributionProps): React.JSX.Element {
  const normalized = points
    .filter((point) => Number.isFinite(point.standing) && Number.isFinite(point.probability))
    .sort((a, b) => a.standing - b.standing)
    .map((point) => ({
      standing: point.standing,
      probability: normalizeProbability(point.probability),
      label: point.label ?? `P${String(point.standing)}`,
    }));

  if (normalized.length === 0) {
    return (
      <section className="dc-standing" aria-labelledby={headingId}>
        <h2 id={headingId} className="dc-standing-heading">
          Projected standing distribution
        </h2>
        <div className="dc-standing-empty" role="status">
          {emptyMessage}
        </div>
      </section>
    );
  }

  const sparklinePoints: SparklinePoint[] = normalized.map((point) => ({
    label: `Standing ${String(point.standing)}`,
    value: point.probability,
  }));

  const caption =
    simulationCount !== undefined
      ? `Simulated probability of finishing at each standing (${String(simulationCount)} runs, seeded).`
      : "Simulated probability of finishing at each standing (seeded).";

  return (
    <section className="dc-standing" aria-labelledby={headingId}>
      <h2 id={headingId} className="dc-standing-heading">
        Projected standing distribution
      </h2>

      <div className="dc-standing-chart-wrap">
        <div className="dc-standing-sparkline" aria-hidden="true">
          <Sparkline
            points={sparklinePoints}
            width={320}
            height={56}
            color="var(--dc-chart-series-1)"
          />
        </div>

        <div className="dc-data-table-scroll">
          <table className="dc-data-table">
            <caption>{caption}</caption>
            <thead>
              <tr>
                <th scope="col">Standing</th>
                <th scope="col" className="dc-numeric">
                  Probability
                </th>
              </tr>
            </thead>
            <tbody>
              {normalized.map((point) => (
                <tr key={point.standing}>
                  <td className="dc-tabular">{point.standing}</td>
                  <td className="dc-numeric dc-tabular">{Math.round(point.probability * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {(p50 !== null && p50 !== undefined) || (p90 !== null && p90 !== undefined) ? (
          <p className="dc-standing-summary">
            {p50 !== null && p50 !== undefined && (
              <span>
                P50 (median): <strong className="dc-tabular">{p50}</strong>
              </span>
            )}
            {p90 !== null && p90 !== undefined && (
              <span>
                P90: <strong className="dc-tabular">{p90}</strong>
              </span>
            )}
            {simulationCount !== undefined && <span>{String(simulationCount)} simulations</span>}
          </p>
        ) : null}
      </div>

      <p role="note" className="dc-standing-note">
        Projection via{" "}
        {simulationCount ? `${String(simulationCount)} seeded simulations` : "seeded simulations"}{" "}
        vs a replacement-built opponent baseline — not real-user percentiles. This is a projection,
        not a guarantee.
      </p>
    </section>
  );
}
