import { DeltaChip } from "./DeltaChip";

export interface RoundValueRow {
  round: number;
  pickInRound: number;
  overallPick: number;
  playerName: string;
  /** Player id for key stability when names duplicate. */
  playerId?: string | undefined;
  /** Value above replacement / normalized value for the pick. */
  valueAboveReplacement?: number | null | undefined;
  /** marketADP - overallPick delta for DeltaChip. Positive = reach. */
  adpDelta?: number | null | undefined;
  isBestValue?: boolean | undefined;
  isBiggestReach?: boolean | undefined;
}

export interface RoundValueTableProps {
  rows: RoundValueRow[];
  caption?: string | undefined;
  emptyMessage?: string | undefined;
}

function formatValue(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(1);
}

/**
 * Round-by-round value table (Phase 3E1).
 *
 * Columns: Round · Pick · Player · Value Above Replacement · Reach (DeltaChip)
 * with Best Value / Biggest Reach markers that include both glyph + text
 * (never color alone). Wrapped in an overflow container so 320px never
 * causes page-level horizontal scroll, and every header uses scope="col".
 */
export function RoundValueTable({
  rows,
  caption = "Value captured each round, with best value and biggest reach highlighted.",
  emptyMessage = "No picks recorded yet.",
}: RoundValueTableProps): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <section className="dc-round-value" aria-labelledby="dc-round-value-heading">
        <h2 id="dc-round-value-heading" className="dc-round-value-heading">
          Round-by-round value
        </h2>
        <div className="dc-round-value-empty" role="status">
          {emptyMessage}
        </div>
      </section>
    );
  }

  const sorted = [...rows].sort((a, b) => a.overallPick - b.overallPick);

  return (
    <section className="dc-round-value" aria-labelledby="dc-round-value-heading">
      <h2 id="dc-round-value-heading" className="dc-round-value-heading">
        Round-by-round value
      </h2>
      <div
        className="dc-round-value-scroll"
        role="region"
        aria-label="Round-by-round value table, scrollable"
        tabIndex={0}
      >
        <table className="dc-round-value-table">
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Round</th>
              <th scope="col">Pick</th>
              <th scope="col">Player</th>
              <th scope="col" className="dc-numeric">
                Value
              </th>
              <th scope="col">Reach</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr
                key={
                  row.playerId
                    ? `${String(row.overallPick)}-${row.playerId}`
                    : String(row.overallPick)
                }
                className="dc-round-value-row"
              >
                <td className="dc-tabular">{row.round}</td>
                <td className="dc-tabular">{row.pickInRound}</td>
                <td>
                  <span className="dc-round-value-player" title={row.playerName}>
                    {row.playerName}
                  </span>
                  {row.isBestValue && (
                    <span
                      className="dc-round-value-marker"
                      data-kind="best"
                      role="img"
                      aria-label="Best value pick"
                    >
                      <span aria-hidden="true">★</span> Best value
                    </span>
                  )}
                  {row.isBiggestReach && (
                    <span
                      className="dc-round-value-marker"
                      data-kind="reach"
                      role="img"
                      aria-label="Biggest reach"
                    >
                      <span aria-hidden="true">●</span> Biggest reach
                    </span>
                  )}
                </td>
                <td className="dc-numeric dc-tabular">{formatValue(row.valueAboveReplacement)}</td>
                <td>
                  {typeof row.adpDelta === "number" && Number.isFinite(row.adpDelta) ? (
                    <DeltaChip delta={row.adpDelta} />
                  ) : (
                    <span className="dc-tabular" style={{ color: "var(--dc-color-text-muted)" }}>
                      —
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
