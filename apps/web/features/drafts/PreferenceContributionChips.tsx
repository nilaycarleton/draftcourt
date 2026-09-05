"use client";

/**
 * Signed preference-contribution evidence inside each recommendation row
 * (Phase 3B). Chips show the top 2–3 contributors as signed score points
 * (contribution × 100, rounded to 0.1) with explicit +/− glyphs and words —
 * never color alone. A collapsible table lists EVERY component with its
 * signed points and the engine's points-based reason; a zero preference
 * contribution is reported honestly ("no personal adjustment"). Warnings
 * render as warning-styled lines next to the recommendation; they are
 * advisory only and never disable the Draft buttons.
 */

export interface ContributionComponentLike {
  key: string;
  contribution: number;
  reason: string;
}

export interface ContributionChipsEntry {
  components: ContributionComponentLike[];
  warnings?: string[] | undefined;
}

const COMPONENT_LABELS: Record<string, string> = {
  production: "Production",
  scarcity: "Scarcity",
  rosterNeed: "Roster need",
  risk: "Risk safety",
  consistency: "Consistency",
  age: "Age curve",
  adpValue: "ADP value",
  upside: "Upside",
  role: "Role",
  nextPickAvailability: "Availability",
  preference: "Preference",
  schedule: "Schedule",
};

const MAX_CHIPS = 3;

/** contribution × 100 = engine points, rounded to a tenth. */
function pointsText(contribution: number): string {
  const rounded = Math.round(Math.abs(contribution) * 1000) / 10;
  if (contribution === 0) return "0";
  return `${contribution > 0 ? "+" : "−"}${rounded.toFixed(1)}`;
}

function labelFor(key: string): string {
  return COMPONENT_LABELS[key] ?? key;
}

export function PreferenceContributionChips({
  entry,
}: {
  entry: ContributionChipsEntry;
}): React.JSX.Element {
  const warnings = entry.warnings ?? [];
  const ranked = [...entry.components]
    .filter((component) => component.contribution !== 0)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution) || (a.key < b.key ? -1 : 1))
    .slice(0, MAX_CHIPS);

  const neutralPreference = entry.components.some(
    (component) => component.key === "preference" && component.contribution === 0,
  );

  return (
    <div className="dc-contrib">
      {/* Warning/contribution items deliberately avoid <li>: this component
          renders INSIDE the recommendations <li>, and nested list items would
          break descendant-list selectors and screen-reader list semantics. */}
      {warnings.length > 0 && (
        <div className="dc-contrib-warnings" aria-label="Strategy warnings">
          {entry.warnings?.map((warning) => (
            <p key={warning} className="dc-contrib-warning">
              {warning}
            </p>
          ))}
        </div>
      )}

      <span className="dc-contrib-chips" aria-label="Top contributions">
        {ranked.map((component) => (
          <span
            key={component.key}
            className="dc-contrib-chip"
            data-tone={component.contribution > 0 ? "positive" : "negative"}
          >
            {pointsText(component.contribution)} {labelFor(component.key)}
          </span>
        ))}
        {neutralPreference && (
          <span className="dc-contrib-chip" data-tone="neutral">
            Preference ±0 — no personal adjustment
          </span>
        )}
      </span>

      <details className="dc-contrib-details">
        <summary>All components</summary>
        <table className="dc-evidence-table dc-contrib-table">
          <caption>Every scored component for this player</caption>
          <thead>
            <tr>
              <th scope="col">Component</th>
              <th scope="col">Points</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            {entry.components.map((component) => (
              <tr key={component.key}>
                <td>{labelFor(component.key)}</td>
                <td className="dc-factor-value" data-tone={toneOf(component.contribution)}>
                  {component.key === "preference" && component.contribution === 0
                    ? "0 (no personal adjustment)"
                    : pointsText(component.contribution)}
                </td>
                <td>{component.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function toneOf(contribution: number): "positive" | "negative" | "neutral" {
  if (contribution > 0) return "positive";
  if (contribution < 0) return "negative";
  return "neutral";
}
