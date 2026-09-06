import { Badge } from "./Badge";
import { Card } from "./Card";

export type HistoryDraftType = "REAL" | "MOCK" | "DEMO";
export type HistoryDraftStatus = "SETUP" | "ACTIVE" | "PAUSED" | "COMPLETED" | "ABANDONED";

export interface HistoryCardProps {
  /** Draft identifier – used for the action link href when provided. */
  id?: string | undefined;
  leagueName: string;
  /** Optional season label, e.g. "2026–27" */
  season?: string | undefined;
  type: HistoryDraftType;
  status: HistoryDraftStatus;
  /** ISO timestamp for the last update. Rendered as a <time> with tabular numerals. */
  updatedAt: string;
  /** Letter grade A–F (with +/-). When null the card shows a neutral empty state. */
  grade?: string | null | undefined;
  /** Numeric grade 0–100. Shown alongside the letter when both are present. */
  gradeScore?: number | null | undefined;
  /** Round/team summary for context, e.g. 12 teams · 13 rounds */
  summary?: string | undefined;
  href?: string | undefined;
  onSelect?: (() => void) | undefined;
  hasAnalysis?: boolean | undefined;
}

/** Maps status to Badge variant – never encodes meaning by color alone; the
 * label is always visible text. */
function statusBadgeVariant(
  status: HistoryDraftStatus,
): "neutral" | "info" | "success" | "warning" | "danger" {
  switch (status) {
    case "COMPLETED":
      return "success";
    case "ACTIVE":
    case "PAUSED":
      return "warning";
    case "ABANDONED":
      return "danger";
    case "SETUP":
    default:
      return "neutral";
  }
}

function typeBadgeVariant(type: HistoryDraftType): "neutral" | "info" | "warning" {
  switch (type) {
    case "REAL":
      return "info";
    case "DEMO":
      return "warning";
    case "MOCK":
    default:
      return "neutral";
  }
}

function gradeTone(grade: string | null | undefined): "strong" | "mid" | "weak" | "neutral" {
  if (!grade) return "neutral";
  const upper = grade.toUpperCase();
  if (upper.startsWith("A") || upper.startsWith("B")) return "strong";
  if (upper.startsWith("C")) return "mid";
  if (upper.startsWith("D") || upper.startsWith("F")) return "weak";
  return "neutral";
}

function formatDate(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date);
  } catch {
    return iso;
  }
}

/**
 * Pure presentational history row/card for the saved-drafts list (Phase 3E1).
 *
 * Token-only styling, 44px action target, truncated long league names,
 * tabular date, and explicit badge text so color is never the sole encoding.
 * Interactive when `href` or `onSelect` is provided – otherwise inert.
 */
export function HistoryCard({
  leagueName,
  season,
  type,
  status,
  updatedAt,
  grade,
  gradeScore,
  summary,
  href,
  onSelect,
  hasAnalysis,
}: HistoryCardProps): React.JSX.Element {
  const hasLink = Boolean(href ?? onSelect);
  const actionLabel =
    status === "COMPLETED" && (hasAnalysis || grade) ? "View results" : "View draft";
  const gradeLabel =
    grade && typeof gradeScore === "number" && Number.isFinite(gradeScore)
      ? `${grade} · ${gradeScore.toFixed(1)}`
      : (grade ?? null);

  const inner = (
    <div className="dc-history-card-inner">
      <div className="dc-history-card-header">
        <div style={{ minWidth: 0, flex: "1 1 180px" }}>
          <h3 className="dc-history-card-title" title={leagueName}>
            {leagueName}
          </h3>
          {season && (
            <p className="dc-history-card-subtitle" title={season}>
              {season}
              {summary ? ` · ${summary}` : ""}
            </p>
          )}
          {!season && summary && <p className="dc-history-card-subtitle">{summary}</p>}
        </div>
        <div className="dc-history-card-badges">
          <Badge variant={typeBadgeVariant(type)}>{type}</Badge>
          <Badge variant={statusBadgeVariant(status)}>{status}</Badge>
          {gradeLabel ? (
            <span
              className="dc-history-card-grade"
              data-tone={gradeTone(grade)}
              aria-label={`Grade ${gradeLabel}`}
            >
              <span aria-hidden="true">
                {gradeTone(grade) === "strong" ? "★" : gradeTone(grade) === "weak" ? "●" : "◆"}
              </span>
              {gradeLabel}
            </span>
          ) : hasAnalysis === false ? (
            <span className="dc-history-card-empty-grade">No grade yet</span>
          ) : null}
        </div>
      </div>

      <div className="dc-history-card-meta">
        <time className="dc-history-card-date" dateTime={updatedAt}>
          {formatDate(updatedAt)}
        </time>
        {hasLink && href ? (
          <a
            href={href}
            className="dc-history-card-action"
            aria-label={`${actionLabel} for ${leagueName}`}
            onClick={onSelect}
          >
            {actionLabel}
          </a>
        ) : hasLink ? (
          <button
            type="button"
            className="dc-history-card-action"
            aria-label={`${actionLabel} for ${leagueName}`}
            onClick={onSelect}
          >
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );

  return (
    <article className="dc-history-card" aria-label={`${leagueName} ${type} draft`}>
      <Card padding="md">
        {hasLink && href
          ? // Card is decorative; the action link inside carries the interaction.
            inner
          : inner}
      </Card>
    </article>
  );
}
