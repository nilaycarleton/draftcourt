/**
 * Deterministic CPU pick selector (DraftCourt Phase 3C). PURE: no framework,
 * no database, no wall-clock time. Given the same immutable input snapshot,
 * the same personality snapshot, and the same draft seed, `selectCpuPick`
 * returns a byte-identical decision (or typed failure) on every platform.
 *
 * Pipeline:
 *   board/turn guards -> legal pool (league+team slot inventory) ->
 *   nine features in declared dimension order -> weighted score ->
 *   total-order sort -> seeded single-roll softmax walk over top-K ->
 *   proposed slot + decision checksum.
 *
 * Failure paths consume ZERO rng draws; every min-max/rank normalization
 * guards degenerate (all-tied) pools with a neutral 0.5 so no NaN can escape.
 */

import type { Position } from "./enums";
import { candidateSlotsForEligibility, overallPickToSlot } from "./draft";
import {
  canonicalize,
  categoryUtility,
  checksumInput,
  computePoolBaselines,
  mulberry32,
  percentageImpacts,
  percentileRank,
  seasonFantasyPoints,
  winsorize,
  type EngineAdpEntry,
  type EngineAssignment,
  type EnginePlayerMeta,
  type EngineProjection,
  type EngineSettings,
} from "./recommendation";
import {
  CPU_TOP_K_DEFAULT,
  cpuFeatureDimensions,
  type CpuFeatureDimension,
  type CpuPersonalitySnapshot,
  type CpuWeightVector,
} from "./cpu-personalities";

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

export interface CpuDecisionInput {
  settings: EngineSettings;
  projectionRunId: string;
  modelVersion: string;
  projections: EngineProjection[];
  players: EnginePlayerMeta[];
  adp: EngineAdpEntry[] | null;
  /** Effective selections so far, including keepers. */
  assignments: EngineAssignment[];
  /** Team slot on the clock — must equal overallPickToSlot(nextOverallPick). */
  currentTeamSlot: number;
  nextOverallPick: number;
  personality: CpuPersonalitySnapshot;
  draftSeed: number;
  includeUnsigned: boolean;
  topK?: number | undefined;
}

export interface CpuCandidateEvidence {
  playerId: string;
  score: number;
  features: CpuWeightVector;
}

export interface CpuSelectionEvidence {
  consideredCount: number;
  topK: CpuCandidateEvidence[];
  chosenFeatures: CpuWeightVector;
  chosenRankInTopK: number;
  temperature: number;
  pickSeedHex: string;
  roll: number;
  proposedSlot: { position: Position; isBench: boolean };
}

export type CpuDecisionFailure =
  | { reason: "EMPTY_POOL"; message: string }
  | { reason: "BOARD_COMPLETE"; message: string }
  | { reason: "INVALID_TEAM_SLOT"; message: string };

export type CpuDecision =
  | {
      ok: true;
      playerId: string;
      score: number;
      evidence: CpuSelectionEvidence;
      /** Checksum of the complete immutable decision input, with unordered
       * collections explicitly sorted. Persisted on the pick event so an
       * operator can prove exactly which board/projection/ADP world was used. */
      inputChecksum: string;
      decisionChecksum: string;
    }
  | { ok: false; failure: CpuDecisionFailure };

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const UTIL_BENCH_MULTIPLIER = 0.7;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Parity: recommendation.ts:1277-1284 (`median`). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const midValue = sorted[mid] ?? 0;
  const prevValue = sorted[mid - 1] ?? midValue;
  return sorted.length % 2 === 1 ? midValue : (prevValue + midValue) / 2;
}

interface PerGameLine {
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
  fgm: number;
  fga: number;
  ftm: number;
  fta: number;
  threePm: number;
}

/** Parity: recommendation.ts:375-390 (`toPerGame`). */
function toPerGameLine(projection: EngineProjection): PerGameLine {
  const games = Math.max(1, projection.games);
  return {
    pts: projection.pts / games,
    reb: projection.reb / games,
    ast: projection.ast / games,
    stl: projection.stl / games,
    blk: projection.blk / games,
    tov: projection.tov / games,
    fgm: projection.fgm / games,
    fga: projection.fga / games,
    ftm: projection.ftm / games,
    fta: projection.fta / games,
    threePm: projection.threePm / games,
  };
}

/** Parity: recommendation.ts:1286-1303 (`normalizeByRank`) — rank-based
 * [0,1] normalization; all-tied pools stay neutral at 0.5. Returns a new map. */
function rankNormalize(source: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  const entries = [...source.entries()];
  if (entries.length === 0) return out;
  if (entries.length === 1) {
    const only = entries[0];
    if (only) out.set(only[0], 0.5);
    return out;
  }
  const sorted = [...entries].sort(
    (a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  const minValue = sorted[0]?.[1] ?? 0;
  const maxValue = sorted[sorted.length - 1]?.[1] ?? 0;
  if (minValue === maxValue) {
    for (const [id] of entries) out.set(id, 0.5);
    return out;
  }
  sorted.forEach(([id], index) => {
    out.set(id, index / (sorted.length - 1));
  });
  return out;
}

/** Linear min-max normalization with the same all-tied ⇒ 0.5 policy as
 * {@link rankNormalize}, per the accepted Phase 3C design. */
function minMaxNormalize(source: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  const entries = [...source.entries()];
  if (entries.length === 0) return out;
  if (entries.length === 1) {
    const only = entries[0];
    if (only) out.set(only[0], 0.5);
    return out;
  }
  let minValue = Number.POSITIVE_INFINITY;
  let maxValue = Number.NEGATIVE_INFINITY;
  for (const [, value] of entries) {
    if (value < minValue) minValue = value;
    if (value > maxValue) maxValue = value;
  }
  if (minValue === maxValue) {
    for (const [id] of entries) out.set(id, 0.5);
    return out;
  }
  for (const [id, value] of entries) {
    out.set(id, (value - minValue) / (maxValue - minValue));
  }
  return out;
}

interface Candidate {
  playerId: string;
  meta: EnginePlayerMeta;
  projection: EngineProjection;
  perGame: PerGameLine;
  fantasyPoints: number;
  utility: number;
  fgZ: number;
  ftZ: number;
}

/** Per-stat raw value for the categoryEmphasis dimension.
 * Parity: recommendation.ts:1174-1206 (`categoryStatValue`) plus the engine's
 * lower-is-better sign flip (recommendation.ts:477) applied to TOV. */
function categoryStatValue(candidate: Candidate, stat: string): number | undefined {
  switch (stat) {
    case "PTS":
      return candidate.perGame.pts;
    case "REB":
      return candidate.perGame.reb;
    case "AST":
      return candidate.perGame.ast;
    case "STL":
      return candidate.perGame.stl;
    case "BLK":
      return candidate.perGame.blk;
    case "TOV":
      return -candidate.perGame.tov; // sign-flipped: fewer turnovers is better
    case "FGM":
      return candidate.perGame.fgm;
    case "FGA":
      return candidate.perGame.fga;
    case "FTM":
      return candidate.perGame.ftm;
    case "FTA":
      return candidate.perGame.fta;
    case "THREE_PM":
    case "3PM":
      return candidate.perGame.threePm;
    case "FG_PCT":
      return clamp01((candidate.fgZ + 4) / 8);
    case "FT_PCT":
      return clamp01((candidate.ftZ + 4) / 8);
    // Fallbacks like categoryUtility (recommendation.ts:470-476).
    case "GAMES":
      return candidate.projection.games / 82;
    case "MINUTES":
      return candidate.projection.minutesPerGame / 48;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The selector entry point
// ---------------------------------------------------------------------------

export function selectCpuPick(input: CpuDecisionInput): CpuDecision {
  const { settings } = input;

  // ---- board/turn guards (no rng consumed) --------------------------------
  const mappedSlot = overallPickToSlot(input.nextOverallPick, settings.teamCount);
  if (mappedSlot !== input.currentTeamSlot) {
    return {
      ok: false,
      failure: {
        reason: "INVALID_TEAM_SLOT",
        message: `nextOverallPick ${String(input.nextOverallPick)} maps to team slot ${String(mappedSlot)}, not ${String(input.currentTeamSlot)}.`,
      },
    };
  }
  const totalPicks = settings.rounds * settings.teamCount;
  if (input.nextOverallPick > totalPicks) {
    return {
      ok: false,
      failure: {
        reason: "BOARD_COMPLETE",
        message: `nextOverallPick ${String(input.nextOverallPick)} exceeds the ${String(totalPicks)}-pick board.`,
      },
    };
  }

  // ---- open-slot inventory -------------------------------------------------
  // League-wide AND team-scoped open counts mirror the transactional
  // authority's computeOpenSlots/chooseSlot (parity: recommendation.ts:584-595
  // for league inventory; rosterNeed's team filter at :1337-1348).
  const draftedIds = new Set(input.assignments.map((assignment) => assignment.playerId));
  const leagueFillsByPosition = new Map<string, number>();
  const teamFillsByPosition = new Map<string, number>();
  for (const assignment of input.assignments) {
    leagueFillsByPosition.set(
      assignment.slotPosition,
      (leagueFillsByPosition.get(assignment.slotPosition) ?? 0) + 1,
    );
    if (assignment.teamSlot === input.currentTeamSlot) {
      teamFillsByPosition.set(
        assignment.slotPosition,
        (teamFillsByPosition.get(assignment.slotPosition) ?? 0) + 1,
      );
    }
  }
  const openSlots = settings.rosterSlots.map((slot) => ({
    position: slot.position,
    isStarter: slot.isStarter,
    leagueOpen: slot.count * settings.teamCount - (leagueFillsByPosition.get(slot.position) ?? 0),
    teamOpen: slot.count - (teamFillsByPosition.get(slot.position) ?? 0),
  }));

  /** First legal candidate slot under makePick's chooseSlot predicate:
   * LEAGUE-open > 0 AND TEAM-open > 0 AND starters/bench parity
   * (candidate==="BENCH" ? !isStarter : isStarter). */
  const findCandidateSlot = (eligiblePositions: string[]): Position | undefined =>
    candidateSlotsForEligibility(eligiblePositions).find((candidate) =>
      openSlots.some(
        (slot) =>
          slot.position === candidate &&
          slot.leagueOpen > 0 &&
          slot.teamOpen > 0 &&
          (candidate === "BENCH" ? !slot.isStarter : slot.isStarter),
      ),
    );

  // ---- legal pool ----------------------------------------------------------
  const projectionsById = new Map(
    input.projections.map((projection) => [projection.playerId, projection]),
  );
  const adpById = new Map((input.adp ?? []).map((entry) => [entry.playerId, entry]));
  const poolMetas = input.players.filter((player) => {
    if (draftedIds.has(player.playerId)) return false;
    if (player.status === "RETIRED") return false;
    if (player.status === "UNSIGNED" && !input.includeUnsigned) return false;
    if (!projectionsById.has(player.playerId)) return false;
    return findCandidateSlot(player.eligiblePositions) !== undefined;
  });
  if (poolMetas.length === 0) {
    return {
      ok: false,
      failure: {
        reason: "EMPTY_POOL",
        message: "No legal candidates remain: pool empty after drafted/status/slot filtering.",
      },
    };
  }

  // ---- candidates (parity: recommendation.ts:653-678) -----------------------
  const baselines = computePoolBaselines(
    poolMetas
      .map((meta) => projectionsById.get(meta.playerId))
      .filter((projection): projection is EngineProjection => projection !== undefined),
  );
  const candidates: Candidate[] = poolMetas.map((meta) => {
    const projection = projectionsById.get(meta.playerId);
    if (!projection) throw new Error("projection missing after pool filter");
    const perGame = toPerGameLine(projection);
    const impact = percentageImpacts(perGame);
    return {
      playerId: meta.playerId,
      meta,
      projection,
      perGame,
      fantasyPoints: seasonFantasyPoints(projection, settings.scoringRules),
      utility: categoryUtility(projection, settings.scoringRules),
      fgZ: (impact.fgImpact - baselines.meanFgImpact) / baselines.sdFgImpact,
      ftZ: (impact.ftImpact - baselines.meanFtImpact) / baselines.sdFtImpact,
    };
  });

  // ---- features (declared dimension order, each clamped to [0,1]) ----------

  // projection — parity: recommendation.ts:706-741 (production component).
  const projectionFeature = new Map<string, number>();
  {
    const isPoints = settings.type === "POINTS";
    const seasonValues = winsorize(candidates.map((candidate) => candidate.fantasyPoints));
    const perGameValues = candidates.map(
      (candidate) => candidate.fantasyPoints / Math.max(1, candidate.projection.games),
    );
    const sortedSeason = [...seasonValues].sort((a, b) => a - b);
    const sortedPerGame = [...perGameValues].sort((a, b) => a - b);
    const utilitiesSorted = candidates.map((candidate) => candidate.utility).sort((a, b) => a - b);
    candidates.forEach((candidate, index) => {
      let value: number;
      if (isPoints) {
        value =
          0.65 * percentileRank(sortedPerGame, perGameValues[index] ?? 0) +
          0.35 * percentileRank(sortedSeason, seasonValues[index] ?? 0);
      } else {
        const reliability = Math.sqrt(Math.min(candidate.projection.games, 82) / 82);
        value =
          percentileRank(utilitiesSorted, candidate.utility) * reliability +
          0.15 * clamp01((candidate.fgZ + candidate.ftZ + 4) / 8);
      }
      projectionFeature.set(candidate.playerId, clamp01(value));
    });
  }

  // adpValue — market-rank attractiveness. A CPU "ADP Follower" must take
  // the best-ranked available player, not the player whose far-away ADP
  // creates the largest recommendation-style value gap. Missing ADP stays
  // neutral and stable ids break equal-market ties in rankNormalize().
  const adpValueFeature = new Map<string, number>();
  const knownAdp = new Map<string, number>();
  for (const candidate of candidates) {
    const entry = adpById.get(candidate.playerId);
    if (entry) knownAdp.set(candidate.playerId, -entry.adp);
  }
  const normalizedKnownAdp = rankNormalize(knownAdp);
  for (const candidate of candidates) {
    adpValueFeature.set(candidate.playerId, normalizedKnownAdp.get(candidate.playerId) ?? 0.5);
  }

  // scarcityFit — pool-relative replacement marginal per starter slot.
  // Parity: recommendation.ts:744-790 adapted to the Phase 3C replacement
  // policy (m-th lowest utility among pool players eligible at the slot).
  const scarcityFitFeature = (() => {
    const starterSlots = settings.rosterSlots.filter(
      (slot) => slot.isStarter && slot.position !== "BENCH",
    );
    const m = Math.max(1, Math.floor(settings.teamCount / 2));
    const allUtilities = candidates.map((candidate) => candidate.utility);
    const replacementByPosition = new Map<string, number>();
    for (const slot of starterSlots) {
      const eligibleUtilities = candidates
        .filter((candidate) => candidate.meta.eligiblePositions.includes(slot.position))
        .map((candidate) => candidate.utility)
        .sort((a, b) => a - b);
      if (eligibleUtilities.length === 0) {
        replacementByPosition.set(slot.position, median(allUtilities));
        continue;
      }
      const idx = Math.min(m - 1, eligibleUtilities.length - 1);
      replacementByPosition.set(slot.position, eligibleUtilities[idx] ?? median(allUtilities));
    }
    const marginals = new Map<string, number>();
    for (const candidate of candidates) {
      let best = Number.NEGATIVE_INFINITY;
      for (const slot of starterSlots) {
        if (!candidate.meta.eligiblePositions.includes(slot.position)) continue;
        const replacement = replacementByPosition.get(slot.position);
        if (replacement === undefined) continue;
        let marginal = candidate.utility - replacement;
        // Parity: recommendation.ts:783-784 UTIL/BENCH multiplier.
        if (slot.position === "UTIL" || slot.position === "BENCH") {
          marginal *= UTIL_BENCH_MULTIPLIER;
        }
        best = Math.max(best, marginal);
      }
      marginals.set(candidate.playerId, best === Number.NEGATIVE_INFINITY ? 0 : best);
    }
    return minMaxNormalize(marginals); // all-tied ⇒ all 0.5
  })();

  // rosterNeed (TEAM-scoped) — coverage-gain parity: recommendation.ts:1365-1375
  // blended with the projection feature per the Phase 3C design.
  const rosterNeedFeature = (() => {
    const totalStarters = settings.rosterSlots
      .filter((slot) => slot.isStarter)
      .reduce((sum, slot) => sum + slot.count, 0);
    const feature = new Map<string, number>();
    for (const candidate of candidates) {
      const fitsOpenTeamStarter = settings.rosterSlots.some(
        (slot) =>
          slot.isStarter &&
          candidate.meta.eligiblePositions.includes(slot.position) &&
          (teamFillsByPosition.get(slot.position) ?? 0) < slot.count,
      );
      const coverageGain = totalStarters > 0 && fitsOpenTeamStarter ? 1 / totalStarters : 0;
      const production = projectionFeature.get(candidate.playerId) ?? 0;
      feature.set(candidate.playerId, clamp01(0.6 * coverageGain * 4 + 0.4 * production));
    }
    return feature;
  })();

  // upside / safety / consistency — parity: recommendation.ts:793-840
  // (legacy, preference-free path).
  const upsideFeature = new Map<string, number>();
  const safetyFeature = new Map<string, number>();
  const consistencyFeature = new Map<string, number>();
  for (const candidate of candidates) {
    const p = candidate.projection;

    const upperFp = seasonFantasyPoints(
      {
        ...p,
        pts: p.upper80.pts ?? p.pts,
        reb: p.upper80.reb ?? p.reb,
        ast: p.upper80.ast ?? p.ast,
      },
      settings.scoringRules,
    );
    upsideFeature.set(
      candidate.playerId,
      clamp01(
        ((upperFp - candidate.fantasyPoints) / Math.max(1, Math.abs(candidate.fantasyPoints))) *
          p.roleSecurity,
      ),
    );

    const width =
      Math.abs((p.upper80.pts ?? 0) - (p.lower80.pts ?? 0)) / Math.max(1, Math.abs(p.pts) + 1);
    safetyFeature.set(
      candidate.playerId,
      clamp01(1 - (0.6 * p.injuryRisk + 0.25 * Math.min(1, width) + 0.15 * (1 - p.roleSecurity))),
    );

    consistencyFeature.set(candidate.playerId, clamp01(p.consistency));
  }

  // ageCurve — parity: recommendation.ts:843-857 (preference-free path):
  // neutral 0.5 without an age or in redraft; youth curve otherwise.
  const ageCurveFeature = new Map<string, number>();
  for (const candidate of candidates) {
    const age = candidate.meta.age;
    ageCurveFeature.set(
      candidate.playerId,
      age === undefined || settings.horizon === "REDRAFT"
        ? 0.5
        : clamp01(Math.exp(-(Math.max(0, age - 24) ** 2) / 40)),
    );
  }

  // categoryEmphasis — enabled non-punted rules sorted by stat; per-stat
  // percentile of the signed per-game value; player value = MAX across rules;
  // no rules ⇒ neutral 0.5 (all-tied stats normalize to 0.5 via rankNormalize).
  const categoryEmphasisFeature = (() => {
    const feature = new Map<string, number>();
    const activeRules = settings.scoringRules
      .filter((rule) => rule.enabled && !rule.punt)
      .sort((a, b) => (a.stat < b.stat ? -1 : a.stat > b.stat ? 1 : 0));
    if (activeRules.length === 0) {
      for (const candidate of candidates) feature.set(candidate.playerId, 0.5);
      return feature;
    }
    const normalizedByRule: Map<string, number>[] = [];
    for (const rule of activeRules) {
      const raw = new Map<string, number>();
      for (const candidate of candidates) {
        const value = categoryStatValue(candidate, rule.stat);
        if (value !== undefined) raw.set(candidate.playerId, value);
      }
      if (raw.size === 0) continue;
      normalizedByRule.push(rankNormalize(raw));
    }
    if (normalizedByRule.length === 0) {
      for (const candidate of candidates) feature.set(candidate.playerId, 0.5);
      return feature;
    }
    for (const candidate of candidates) {
      let best = 0;
      let any = false;
      for (const normalized of normalizedByRule) {
        const value = normalized.get(candidate.playerId);
        if (value === undefined) continue;
        any = true;
        best = Math.max(best, value);
      }
      feature.set(candidate.playerId, any ? best : 0.5);
    }
    return feature;
  })();

  const featuresByDimension: Record<CpuFeatureDimension, Map<string, number>> = {
    projection: projectionFeature,
    adpValue: adpValueFeature,
    scarcityFit: scarcityFitFeature,
    rosterNeed: rosterNeedFeature,
    upside: upsideFeature,
    safety: safetyFeature,
    consistency: consistencyFeature,
    ageCurve: ageCurveFeature,
    categoryEmphasis: categoryEmphasisFeature,
  };

  // ---- scores (dimension-declared summation order) -------------------------
  const scored = candidates.map((candidate) => {
    const features = {} as CpuWeightVector;
    let score = 0;
    for (const dimension of cpuFeatureDimensions) {
      const value = clamp01(featuresByDimension[dimension].get(candidate.playerId) ?? 0);
      features[dimension] = value;
      score += input.personality.weights[dimension] * value;
    }
    return { playerId: candidate.playerId, score, features };
  });

  // ---- total order: score desc -> adp ASC (missing adp LAST) -> id asc -----
  const sorted = [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const adpA = adpById.get(a.playerId)?.adp ?? Number.POSITIVE_INFINITY;
    const adpB = adpById.get(b.playerId)?.adp ?? Number.POSITIVE_INFINITY;
    if (adpA !== adpB) return adpA - adpB;
    return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
  });

  const requestedTopK = Number.isInteger(input.topK)
    ? Math.max(1, input.topK ?? CPU_TOP_K_DEFAULT)
    : CPU_TOP_K_DEFAULT;
  const k = Math.min(requestedTopK, CPU_TOP_K_DEFAULT, sorted.length);
  const topK = sorted.slice(0, k);

  const inputChecksum = checksumInput(
    canonicalize({
      settings: input.settings,
      projectionRunId: input.projectionRunId,
      modelVersion: input.modelVersion,
      projections: [...input.projections].sort((a, b) =>
        a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0,
      ),
      players: input.players
        .map((player) => ({
          ...player,
          eligiblePositions: [...player.eligiblePositions].sort(),
        }))
        .sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0)),
      adp:
        input.adp === null
          ? null
          : [...input.adp].sort((a, b) =>
              a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0,
            ),
      assignments: [...input.assignments].sort(
        (a, b) =>
          a.teamSlot - b.teamSlot ||
          (a.slotPosition < b.slotPosition ? -1 : a.slotPosition > b.slotPosition ? 1 : 0) ||
          (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0),
      ),
      currentTeamSlot: input.currentTeamSlot,
      nextOverallPick: input.nextOverallPick,
      personality: input.personality,
      draftSeed: input.draftSeed,
      includeUnsigned: input.includeUnsigned,
      topK: k,
    }),
  );

  // ---- seed derivation: ONE roll per (strategy, seed, personality, turn) ---
  const pickSeedHex = checksumInput(
    canonicalize({
      seedStrategyVersion: input.personality.seedStrategyVersion,
      draftSeed: input.draftSeed,
      personalityKey: input.personality.key,
      personalityVersion: input.personality.version,
      teamSlot: input.currentTeamSlot,
      nextOverallPick: input.nextOverallPick,
    }),
  );
  const rand = mulberry32(parseInt(pickSeedHex.slice(0, 8), 16) >>> 0);
  const roll = rand(); // exactly ONE draw

  // ---- stable softmax over the SORTED top-K ---------------------------------
  const temperature = input.personality.temperature;
  const zScores = topK.map((entry) => entry.score / temperature);
  let zMax = Number.NEGATIVE_INFINITY;
  for (const z of zScores) zMax = Math.max(zMax, z);
  const weights = zScores.map((z) => Math.exp(z - zMax));
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);

  let chosenIndex = topK.length - 1; // fallback last
  {
    let cumulative = 0;
    const denominator = weightTotal > 0 ? weightTotal : 1;
    for (let index = 0; index < weights.length; index++) {
      cumulative += (weights[index] ?? 0) / denominator;
      if (roll <= cumulative) {
        chosenIndex = index;
        break;
      }
    }
  }
  const chosen = topK[chosenIndex];
  if (!chosen) throw new Error("invariant: softmax walk produced no candidate");

  // ---- proposed slot (same predicate as pool admission) --------------------
  const chosenMeta = poolMetas.find((meta) => meta.playerId === chosen.playerId);
  if (!chosenMeta) throw new Error("invariant: chosen player missing from pool metas");
  const proposedPosition = findCandidateSlot(chosenMeta.eligiblePositions);
  if (!proposedPosition) throw new Error("invariant: chosen player lost its legal slot");

  // ---- decision checksum ---------------------------------------------------
  const decisionChecksum = checksumInput(
    canonicalize({
      playerId: chosen.playerId,
      score: chosen.score,
      evidenceTopKPlayerIdsInOrder: topK.map((entry) => entry.playerId),
      temperature,
      pickSeedHex,
      roll,
    }),
  );

  return {
    ok: true,
    playerId: chosen.playerId,
    score: chosen.score,
    inputChecksum,
    evidence: {
      consideredCount: candidates.length,
      topK: topK.map((entry) => ({
        playerId: entry.playerId,
        score: entry.score,
        features: entry.features,
      })),
      chosenFeatures: chosen.features,
      chosenRankInTopK: chosenIndex + 1,
      temperature,
      pickSeedHex,
      roll,
      proposedSlot: { position: proposedPosition, isBench: proposedPosition === "BENCH" },
    },
    decisionChecksum,
  };
}
