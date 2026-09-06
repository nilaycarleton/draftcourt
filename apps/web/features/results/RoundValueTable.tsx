"use client";

import { RoundValueTable as UiRoundValueTable, type RoundValueRow } from "@draftcourt/ui";

/**
 * Feature wrapper around the UI RoundValueTable (Phase 3E1).
 *
 * Isolated – receives the round-by-round value payload from the analysis
 * read model. No data fetching or server coupling.
 */

export type { RoundValueRow } from "@draftcourt/ui";

export interface FeatureRoundValueTableProps {
  rows: RoundValueRow[];
  caption?: string | undefined;
}

export function RoundValueTable({ rows, caption }: FeatureRoundValueTableProps): React.JSX.Element {
  return <UiRoundValueTable rows={rows} caption={caption} />;
}
