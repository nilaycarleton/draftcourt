import { preferenceFactorKeys, type PreferenceSettings } from "@draftcourt/domain";

/**
 * One-sentence plain-language strategy summary (Phase 3A/3B). Pure function —
 * no fetch, no state — so the preferences workspace, the pre-draft preview
 * (StartDraftFlow), and tests all render the SAME wording for the same
 * strategy content. Accepts either a stored `PreferenceSettings` envelope or
 * a resolved-strategy `settingsSummary` view (GET /leagues/[id]/strategy-preview).
 */

const FACTOR_LABELS: Record<string, string> = {
  production: "projected production",
  scarcity: "positional scarcity",
  rosterNeed: "roster need",
  risk: "injury risk safety",
  consistency: "consistency",
  age: "age curve",
  adpValue: "ADP value",
  upside: "upside",
  role: "role / minutes",
  nextPickAvailability: "next-pick availability",
  preference: "personal preference",
};

/** The settingsSummary projection shared by the strategy-preview route and
 * the draft-room evidence snapshot. */
export interface StrategySummaryView {
  topFactors: { key: string; weight: number }[];
  punts: string[];
  avoidMode: "EXCLUDE" | "SEVERE_PENALTY";
  scheduleEnabled: boolean;
  favoritePlayers?: number;
  dislikedPlayers?: number;
  targetPlayers?: number;
  avoidedPlayers?: number;
  teamPreferences?: number;
  customRanks?: number;
}

function labelFor(key: string): string {
  return FACTOR_LABELS[key] ?? key;
}

/**
 * Builds the sentence. Order mirrors the editor: top factors → punts →
 * schedule note → personalization counts → avoid behavior last.
 */
export function strategyPreview(source: PreferenceSettings | StrategySummaryView): string {
  const view: StrategySummaryView = "factorWeights" in source ? summarizeSettings(source) : source;

  const ranked = [...view.topFactors]
    .sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : 1))
    .slice(0, 2)
    .map((factor) => labelFor(factor.key));
  const first = ranked[0] ?? "production";
  const second = ranked[1] ?? "value";

  const parts = [`This profile weighs ${first} and ${second} most`];
  if (view.punts.length > 0) parts.push(`punts ${view.punts.join(", ")}`);
  if (view.scheduleEnabled) parts.push("values playoff-week schedules");

  const adjustments: string[] = [];
  const playerCounts: [number, string][] = [
    [view.favoritePlayers ?? 0, "favorite"],
    [view.targetPlayers ?? 0, "target"],
    [view.dislikedPlayers ?? 0, "disliked"],
    [view.avoidedPlayers ?? 0, "avoided"],
  ];
  for (const [count, kind] of playerCounts) {
    if (count > 0) adjustments.push(`${String(count)} ${kind} player${count === 1 ? "" : "s"}`);
  }
  if ((view.teamPreferences ?? 0) > 0) {
    adjustments.push(`${String(view.teamPreferences)} team note(s)`);
  }
  if ((view.customRanks ?? 0) > 0) {
    adjustments.push(`${String(view.customRanks)} custom rank(s)`);
  }
  if (adjustments.length > 0) {
    parts.push(`adjusts for ${joinAnd(adjustments)}`);
  }

  parts.push(
    view.avoidMode === "EXCLUDE"
      ? "and removes avoided players entirely"
      : "and heavily penalizes avoided players",
  );
  return `${parts.join(", ")}.`;
}

/** "a"; "a and b"; "a, b, and c" — no trailing-comma debris. */
function joinAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1] ?? ""}`;
}

/** Projects a stored settings envelope into the same view shape. Player/team
 * list rows live OUTSIDE `PreferenceSettings`, so counts stay absent here and
 * the sentence skips that clause. */
function summarizeSettings(settings: PreferenceSettings): StrategySummaryView {
  const topFactors = [...preferenceFactorKeys]
    .map((key) => ({ key, weight: settings.factorWeights[key] }))
    .sort((a, b) => b.weight - a.weight);
  return {
    topFactors,
    punts: [...settings.puntStats],
    avoidMode: settings.avoidMode,
    scheduleEnabled: settings.schedule.enabled,
  };
}
