"use client";

import { GradeHero as UiGradeHero } from "@draftcourt/ui";

/**
 * Feature wrapper around the UI GradeHero (Phase 3E1).
 *
 * Accepts the analysis payload shape from `DraftAnalysis` so the page can
 * pass the server read model directly. Isolated – no data fetching here.
 */

export interface FeatureGradeHeroProps {
  grade: string;
  gradeScore: number;
  analysisVersion?: string | undefined;
  inputChecksum?: string | undefined;
  generatedAt?: string | undefined;
  confidence?: "LOW" | "MEDIUM" | "HIGH" | undefined;
}

export function GradeHero(props: FeatureGradeHeroProps): React.JSX.Element {
  return (
    <UiGradeHero
      grade={props.grade}
      gradeScore={props.gradeScore}
      analysisVersion={props.analysisVersion}
      inputChecksum={props.inputChecksum}
      generatedAt={props.generatedAt}
      confidence={props.confidence}
    />
  );
}
