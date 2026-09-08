import { ScoreBar } from "./ScoreBar";

export interface GradeHeroProps {
  /** Letter grade, e.g. "A", "B+", "C-", "F". */
  grade: string;
  /** Numeric score 0..100 (one decimal). */
  gradeScore: number;
  /** Analysis version, e.g. "1.0.0" – shown truncated in meta. */
  analysisVersion?: string | undefined;
  /** Full input checksum hex – displayed truncated with full value in title. */
  inputChecksum?: string | undefined;
  /** ISO timestamp when analysis was generated. */
  generatedAt?: string | undefined;
  /** Confidence band for the underlying data. */
  confidence?: "LOW" | "MEDIUM" | "HIGH" | undefined;
}

function truncateChecksum(checksum: string): string {
  if (checksum.length <= 12) return checksum;
  return `${checksum.slice(0, 8)}…${checksum.slice(-4)}`;
}

function formatGeneratedAt(iso: string | undefined): string | null {
  if (!iso) return null;
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return iso;
  }
}

/**
 * Hero grade display for the results page (Phase 3E1).
 *
 * Shows a large letter badge, numeric 0–100 with a ScoreBar, and a
 * mandatory disclosure note ("projection, not a guarantee") in role=note.
 * Color is never sole encoding – the letter and numeric text carry meaning
 * with a glyph prefix; high-contrast adds border weight, reduced-motion
 * disables any reveal.
 */
export function GradeHero({
  grade,
  gradeScore,
  analysisVersion,
  inputChecksum,
  generatedAt,
  confidence,
}: GradeHeroProps): React.JSX.Element {
  const clampedScore = Math.max(0, Math.min(100, gradeScore));
  const normalized = clampedScore / 100;
  const gradeKey = grade.toUpperCase();
  // Bar band follows the LETTER band (A elite, B strong, C/D solid, F risky)
  // so the fill never contradicts the letter color; the default quartile
  // scale would paint an F distinctly brown (Phase 3F Impeccable).
  const firstLetter = gradeKey.slice(0, 1);
  const tone =
    firstLetter === "A"
      ? ("elite" as const)
      : firstLetter === "B"
        ? ("strong" as const)
        : firstLetter === "F"
          ? ("risky" as const)
          : ("solid" as const);
  const confidenceLabel =
    confidence === "HIGH"
      ? "High confidence"
      : confidence === "MEDIUM"
        ? "Medium confidence"
        : confidence === "LOW"
          ? "Low confidence"
          : null;

  return (
    <section className="dc-grade-hero" aria-labelledby="dc-grade-hero-heading">
      <h2 id="dc-grade-hero-heading" className="dc-visually-hidden">
        Draft grade
      </h2>

      <div className="dc-grade-hero-main">
        <div
          className="dc-grade-hero-letter"
          data-grade={gradeKey}
          // role="img": the letter is a graphical badge whose accessible name
          // is the grade (Phase 3F a11y — bare aria-label on role-less
          // elements is dropped by assistive tech).
          role="img"
          aria-label={`Grade ${grade}`}
          title={`Grade ${grade} — ${clampedScore.toFixed(1)} out of 100`}
        >
          {grade}
        </div>

        <div className="dc-grade-hero-score">
          <div className="dc-grade-hero-number-row">
            <span className="dc-tabular dc-grade-hero-number">{clampedScore.toFixed(1)}</span>
            <span className="dc-grade-hero-outof">/ 100</span>
            {confidenceLabel && (
              // No aria-label here: the visible text already carries the
              // confidence so AT announces it once (Phase 3F a11y).
              <span className="dc-badge-row" style={{ marginLeft: "var(--dc-space-2)" }}>
                <span
                  className="dc-tabular"
                  style={{
                    fontSize: "var(--dc-font-size-xs)",
                    color: "var(--dc-color-text-secondary)",
                  }}
                >
                  {confidenceLabel}
                </span>
              </span>
            )}
          </div>
          <ScoreBar label="Overall grade" value={normalized} tone={tone} />
        </div>
      </div>

      <p role="note" className="dc-grade-hero-note">
        This analysis is a projection, not a guarantee. It compares your roster to a
        replacement-built opponent baseline, not to real-user percentiles.
      </p>

      {(analysisVersion ?? inputChecksum ?? generatedAt) && (
        <p className="dc-grade-hero-meta">
          {analysisVersion && <span>Analysis v{analysisVersion}</span>}
          {inputChecksum && (
            // title carries the full value for hover/AT description; the
            // visible truncated text is the accessible name (Phase 3F a11y).
            <code title={inputChecksum}>{truncateChecksum(inputChecksum)}</code>
          )}
          {generatedAt && formatGeneratedAt(generatedAt) && (
            <time dateTime={generatedAt}>{formatGeneratedAt(generatedAt)}</time>
          )}
        </p>
      )}
    </section>
  );
}
