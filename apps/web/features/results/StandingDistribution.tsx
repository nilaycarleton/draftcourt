"use client";

import {
  StandingDistribution as UiStandingDistribution,
  type StandingDistributionPoint,
} from "@draftcourt/ui";

/**
 * Feature wrapper around UI StandingDistribution (Phase 3E1).
 *
 * Isolated – receives the projected standing payload from the analysis
 * read model. Sparkline is decorative; the table is the accessible
 * alternative.
 */

export type { StandingDistributionPoint } from "@draftcourt/ui";

export interface FeatureStandingDistributionProps {
  points: StandingDistributionPoint[];
  p50?: number | null | undefined;
  p90?: number | null | undefined;
  simulationCount?: number | undefined;
}

export function StandingDistribution({
  points,
  p50,
  p90,
  simulationCount,
}: FeatureStandingDistributionProps): React.JSX.Element {
  return (
    <UiStandingDistribution points={points} p50={p50} p90={p90} simulationCount={simulationCount} />
  );
}
