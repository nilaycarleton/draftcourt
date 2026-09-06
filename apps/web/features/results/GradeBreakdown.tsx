"use client";

import { GradeBreakdown as UiGradeBreakdown } from "@draftcourt/ui";
import type { AnalysisComponent } from "@draftcourt/domain";

export function GradeBreakdown({ components }: { components: AnalysisComponent[] }) {
  const mapped = components.map((c) => ({
    key: c.key,
    value: typeof c.normalized === "number" ? c.normalized : 0,
    weight: c.weight,
    reason: c.reason,
  }));
  return <UiGradeBreakdown components={mapped} />;
}
