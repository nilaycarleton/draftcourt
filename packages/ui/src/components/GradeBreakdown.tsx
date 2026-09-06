import { ScoreBar } from "./ScoreBar";

export interface GradeBreakdownComponent {
  /** Component key, e.g. "valueCaptured" */
  key: string;
  /** Display label override; falls back to humanized key. */
  label?: string | undefined;
  /** Normalized score 0..1 for the bar. */
  value: number;
  /** Optional reason/explanation shown beneath the bar. */
  reason?: string | undefined;
  /** Optional weight (0..1) for a11y label detail. */
  weight?: number | undefined;
}

export interface GradeBreakdownProps {
  components: GradeBreakdownComponent[];
  headingId?: string | undefined;
  heading?: string | undefined;
}

const LABELS: Record<string, string> = {
  valueCaptured: "Value captured",
  projectedStrength: "Projected strength",
  rosterBalance: "Roster balance",
  risk: "Risk",
  scoringFit: "Scoring fit",
  // legacy / alternate keys
  value: "Value captured",
  strength: "Projected strength",
  balance: "Roster balance",
  fit: "Scoring fit",
};

function labelFor(key: string, explicit?: string): string {
  if (explicit) return explicit;
  return LABELS[key] ?? key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

/**
 * Five-component grade breakdown for the results page (Phase 3E1).
 *
 * Each component is a ScoreBar with explicit percentage text plus an
 * optional reason line. The heading sequence is h2 by default so callers
 * can maintain h1 → h2 order per page.
 */
export function GradeBreakdown({
  components,
  headingId = "dc-grade-breakdown-heading",
  heading = "Grade breakdown",
}: GradeBreakdownProps): React.JSX.Element {
  if (components.length === 0) {
    return (
      <section className="dc-grade-breakdown" aria-labelledby={headingId}>
        <h2 id={headingId} className="dc-grade-breakdown-heading">
          {heading}
        </h2>
        <p style={{ color: "var(--dc-color-text-secondary)", fontSize: "var(--dc-font-size-sm)" }}>
          No breakdown available.
        </p>
      </section>
    );
  }

  return (
    <section className="dc-grade-breakdown" aria-labelledby={headingId}>
      <h2 id={headingId} className="dc-grade-breakdown-heading">
        {heading}
      </h2>
      <ul className="dc-grade-breakdown-list">
        {components.map((component) => (
          <li key={component.key} className="dc-grade-breakdown-item">
            <ScoreBar label={labelFor(component.key, component.label)} value={component.value} />
            {component.reason && <p className="dc-grade-breakdown-reason">{component.reason}</p>}
            {typeof component.weight === "number" && (
              <span className="dc-visually-hidden">
                Weight {Math.round(component.weight * 100)} percent
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
