import { ScoreBar } from "./ScoreBar";

export interface StrengthWeaknessItem {
  /** Position key (PG, SG…) or category stat key (PTS, REB…). */
  key: string;
  /** Human label shown in the header. */
  label: string;
  /** Normalized score 0..1 for the bar. */
  value: number;
  /** Strength vs weakness vs neutral. Rendered with glyph + text, never color alone. */
  tone: "strength" | "weakness" | "neutral";
  /** Optional detail reason. */
  reason?: string | undefined;
}

export interface StrengthWeaknessCardsProps {
  title?: string | undefined;
  headingId?: string | undefined;
  positionItems?: StrengthWeaknessItem[] | undefined;
  categoryItems?: StrengthWeaknessItem[] | undefined;
  emptyMessage?: string | undefined;
}

function toneGlyph(tone: StrengthWeaknessItem["tone"]): string {
  switch (tone) {
    case "strength":
      return "▲";
    case "weakness":
      return "▼";
    default:
      return "–";
  }
}

function toneLabel(tone: StrengthWeaknessItem["tone"]): string {
  switch (tone) {
    case "strength":
      return "Strength";
    case "weakness":
      return "Weakness";
    default:
      return "Balanced";
  }
}

function CardForItem({ item }: { item: StrengthWeaknessItem }): React.JSX.Element {
  return (
    <li className="dc-sw-card" data-tone={item.tone}>
      <div className="dc-sw-card-header">
        <span className="dc-sw-label" title={item.label}>
          {item.label}
        </span>
        <span
          className="dc-sw-badge"
          data-tone={item.tone}
          role="img"
          aria-label={toneLabel(item.tone)}
        >
          <span aria-hidden="true">{toneGlyph(item.tone)}</span>
          {toneLabel(item.tone)}
        </span>
      </div>
      <ScoreBar label={item.label} value={item.value} />
      {item.reason && (
        <p
          style={{
            margin: 0,
            fontSize: "var(--dc-font-size-xs)",
            color: "var(--dc-color-text-secondary)",
            lineHeight: "var(--dc-line-height-normal)",
          }}
        >
          {item.reason}
        </p>
      )}
    </li>
  );
}

/**
 * Position/category strengths and weaknesses (Phase 3E1).
 *
 * Each item is a card with a ScoreBar plus an explicit Strength/Weakness
 * badge that pairs a glyph with text – never color alone. Two grids:
 * positions and categories. Empty states are visible and announced, not
 * silent.
 */
export function StrengthWeaknessCards({
  title = "Strengths & weaknesses",
  headingId = "dc-sw-heading",
  positionItems = [],
  categoryItems = [],
  emptyMessage = "No strengths or weaknesses to show.",
}: StrengthWeaknessCardsProps): React.JSX.Element {
  const hasPositions = positionItems.length > 0;
  const hasCategories = categoryItems.length > 0;
  const isEmpty = !hasPositions && !hasCategories;

  return (
    <section className="dc-sw" aria-labelledby={headingId}>
      <h2 id={headingId} className="dc-sw-heading">
        {title}
      </h2>

      {isEmpty ? (
        <div className="dc-sw-empty" role="status">
          {emptyMessage}
        </div>
      ) : (
        <>
          {hasPositions && (
            <div>
              <h3
                style={{
                  margin: "0 0 var(--dc-space-2)",
                  fontSize: "var(--dc-font-size-sm)",
                  color: "var(--dc-color-text-secondary)",
                  fontWeight: 600,
                }}
              >
                By position
              </h3>
              <ul className="dc-sw-grid" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {positionItems.map((item) => (
                  <CardForItem key={`pos-${item.key}`} item={item} />
                ))}
              </ul>
            </div>
          )}

          {hasCategories && (
            <div>
              <h3
                style={{
                  margin: "0 0 var(--dc-space-2)",
                  fontSize: "var(--dc-font-size-sm)",
                  color: "var(--dc-color-text-secondary)",
                  fontWeight: 600,
                }}
              >
                By category
              </h3>
              <ul className="dc-sw-grid" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {categoryItems.map((item) => (
                  <CardForItem key={`cat-${item.key}`} item={item} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
