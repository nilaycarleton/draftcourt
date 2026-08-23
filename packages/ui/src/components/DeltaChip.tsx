/**
 * Internal-rank-vs-ADP "value delta" indicator — DraftCourt's signature
 * player-list element. Never encodes meaning by color alone (BUILD_SPEC.md
 * section 10.2): direction is always also spelled out as a glyph + word for
 * screen readers and color-blind users, using the existing draft-score-band
 * tokens rather than a raw green/red good/bad binary.
 */
export interface DeltaChipProps {
  /** internalRank - marketRank. Negative means DraftCourt ranks the player
   * *ahead of* the market (a value pick). */
  delta: number;
}

const ELITE_THRESHOLD = -10;
const RISKY_THRESHOLD = 10;

function bandFor(delta: number): { token: string; label: string } {
  if (delta <= ELITE_THRESHOLD)
    return { token: "var(--dc-color-score-elite)", label: "strong value" };
  if (delta < 0) return { token: "var(--dc-color-score-strong)", label: "value" };
  if (delta < RISKY_THRESHOLD) return { token: "var(--dc-color-score-solid)", label: "at market" };
  return { token: "var(--dc-color-score-risky)", label: "reach" };
}

export function DeltaChip({ delta }: DeltaChipProps) {
  const rounded = Math.round(delta);
  const { token, label } = bandFor(rounded);
  const glyph = rounded < 0 ? "▲" : rounded > 0 ? "▼" : "–";
  const signed = rounded > 0 ? `+${String(rounded)}` : String(rounded);

  return (
    <span className="dc-delta-chip" style={{ color: token, borderColor: token }}>
      <span aria-hidden="true">{glyph}</span>
      <span className="dc-tabular">{signed}</span>
      <span className="dc-visually-hidden"> vs. market ADP ({label})</span>
    </span>
  );
}
