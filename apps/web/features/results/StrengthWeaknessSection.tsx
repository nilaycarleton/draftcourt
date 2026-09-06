"use client";

import {
  StrengthWeaknessCards as UiStrengthWeaknessCards,
  type StrengthWeaknessItem,
} from "@draftcourt/ui";

/**
 * Feature wrapper around UI StrengthWeaknessCards (Phase 3E1).
 *
 * Isolated – maps the analysis strengths/weaknesses payload (position +
 * category) into the UI primitive. No data fetching.
 */

export type { StrengthWeaknessItem } from "@draftcourt/ui";

export interface StrengthWeaknessSectionProps {
  positionStrengths?: StrengthWeaknessItem[] | undefined;
  categoryStrengths?: StrengthWeaknessItem[] | undefined;
  title?: string | undefined;
}

export function StrengthWeaknessSection({
  positionStrengths = [],
  categoryStrengths = [],
  title,
}: StrengthWeaknessSectionProps): React.JSX.Element {
  return (
    <UiStrengthWeaknessCards
      title={title}
      positionItems={positionStrengths}
      categoryItems={categoryStrengths}
    />
  );
}
