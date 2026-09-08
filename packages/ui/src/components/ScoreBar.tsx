/**
 * Labeled 0-1 score as a horizontal bar + explicit percentage text — used
 * for injuryRisk/consistency/upside/roleSecurity. Text is always present
 * (never a bar-only indicator), so the value survives for screen readers
 * and print/high-contrast modes alike.
 */
export interface ScoreBarProps {
  label: string;
  value: number; // 0..1
  /** For risk-style scores, a higher raw value is worse — flips the fill
   * color toward the danger end of the scale without changing the number
   * shown (still "0.25 injury risk", never inverted into a fake "safety"
   * score the reader has to re-derive). */
  invert?: boolean;
  /** Explicit band override (e.g. a grade letter band) so the fill color can
   * match a sibling indicator that bands the same value differently than the
   * default quartile scale. Defaults to the quartile mapping. */
  tone?: "elite" | "strong" | "solid" | "risky" | undefined;
}

const TONE_COLOR: Record<NonNullable<ScoreBarProps["tone"]>, string> = {
  elite: "var(--dc-color-score-elite)",
  strong: "var(--dc-color-score-strong)",
  solid: "var(--dc-color-score-solid)",
  risky: "var(--dc-color-score-risky)",
};

export function ScoreBar({ label, value, invert = false, tone }: ScoreBarProps) {
  const clamped = Math.max(0, Math.min(1, value));
  const percent = Math.round(clamped * 100);
  const effective = invert ? 1 - clamped : clamped;
  const color =
    tone !== undefined
      ? TONE_COLOR[tone]
      : effective >= 0.75
        ? "var(--dc-color-score-elite)"
        : effective >= 0.5
          ? "var(--dc-color-score-strong)"
          : effective >= 0.25
            ? "var(--dc-color-score-solid)"
            : "var(--dc-color-score-risky)";

  return (
    <div className="dc-score-bar" role="group" aria-label={`${label}: ${String(percent)}%`}>
      <div className="dc-score-bar-header">
        <span>{label}</span>
        <span className="dc-tabular">{percent}%</span>
      </div>
      <div className="dc-score-bar-track" aria-hidden="true">
        <div
          className="dc-score-bar-fill"
          style={{ width: `${String(percent)}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}
