"use client";

import { HistoryCard as UiHistoryCard } from "@draftcourt/ui";

/** Feature wrapper around the UI primitive – adds Next.js link wiring while
 * keeping the presentational contract token-only and testable in isolation. */

export interface FeatureHistoryCardProps {
  id: string;
  leagueName: string;
  season?: string | undefined;
  type: "REAL" | "MOCK" | "DEMO";
  status: "SETUP" | "ACTIVE" | "PAUSED" | "COMPLETED" | "ABANDONED";
  updatedAt: string;
  grade?: string | null | undefined;
  gradeScore?: number | null | undefined;
  summary?: string | undefined;
  hasAnalysis?: boolean | undefined;
}

export function HistoryCard(props: FeatureHistoryCardProps): React.JSX.Element {
  const href =
    props.status === "COMPLETED" && (props.hasAnalysis || props.grade)
      ? `/drafts/${props.id}/results`
      : `/drafts/${props.id}`;

  return (
    <UiHistoryCard
      id={props.id}
      leagueName={props.leagueName}
      season={props.season}
      type={props.type}
      status={props.status}
      updatedAt={props.updatedAt}
      grade={props.grade}
      gradeScore={props.gradeScore}
      summary={props.summary}
      hasAnalysis={props.hasAnalysis}
      href={href}
    />
  );
}
