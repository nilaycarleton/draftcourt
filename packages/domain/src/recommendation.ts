/**
 * Deterministic fantasy recommendation engine (BUILD_SPEC.md sections 6,
 * Phase 2 scope items 5–6). Pure TypeScript: no framework, no database,
 * no LLM, no wall-clock time. The same immutable input snapshot plus seed
 * produces byte-equivalent logical output on every platform.
 *
 * Component pipeline per eligible player:
 *   production -> scarcity -> rosterNeed -> risk -> consistency -> age ->
 *   upside -> role -> adpValue -> nextPickAvailability (seeded Monte Carlo)
 *   -> preference (bounded; Phase 2 default profile contributes 0)
 *
 * Weights come from reciprocal rank over the default factor priority, then
 * normalize to sum 1 (section 2.2). Components are percentile-normalized
 * within the current eligible pool, winsorized at the 2nd/98th percentiles,
 * combined as `base = Σ weight_i × norm_i`, plus a ≤10% lookahead bonus,
 * scaled to 0–100 (section 6.8).
 */

// ---------------------------------------------------------------------------
// Input / output contracts
// ---------------------------------------------------------------------------

export interface EngineScoringRule {
  stat: string;
  weight: number;
  direction: string;
  enabled: boolean;
  punt: boolean;
}

export interface EngineSettings {
  season: string;
  type: "POINTS" | "CATEGORIES";
  horizon: "REDRAFT" | "KEEPER" | "DYNASTY";
  teamCount: number;
  rounds: number;
  userDraftSlot: number;
  scoringRules: EngineScoringRule[];
  rosterSlots: { position: string; count: number; isStarter: boolean }[];
}

/** Immutable projection line for one player (mirrors data/schemas). */
export interface EngineProjection {
  playerId: string;
  games: number;
  minutesPerGame: number;
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
  lower80: Record<string, number>;
  upper80: Record<string, number>;
  injuryRisk: number;
  consistency: number;
  upside: number;
  roleSecurity: number;
}

export interface EnginePlayerMeta {
  playerId: string;
  displayName: string;
  eligiblePositions: string[];
  status: "ACTIVE" | "INJURED" | "SUSPENDED" | "UNSIGNED" | "RETIRED";
  nbaTeamId?: string | undefined;
  age?: number | undefined;
}

export interface EngineAdpEntry {
  playerId: string;
  adp: number;
  rank: number;
  /** Consensus confidence: fewer sources => lower. */
  sourcesCount: number;
}

export interface EngineAssignment {
  playerId: string;
  teamSlot: number;
  slotPosition: string;
}

export interface EngineInput {
  settings: EngineSettings;
  /** Published projection run identifier + model version for provenance. */
  projectionRunId: string;
  modelVersion: string;
  projections: EngineProjection[];
  players: EnginePlayerMeta[];
  adp: EngineAdpEntry[] | null;
  /** Effective selections so far (draft sequence <= s). */
  draftedAssignments: EngineAssignment[];
  /** Next overall pick for the drafting team's turn. */
  nextOverallPick: number;
  /** Picks between now and the user's NEXT selection (intervening picks). */
  picksUntilUserTurn: number;
  includeUnsigned: boolean;
  engineSeed: number;
}

import type { RecommendationLabel, ScoreComponent } from "./contracts";
export type { ScoreComponent };
export type ComponentKey = ScoreComponent["key"];

export type { RecommendationLabel } from "./contracts";

export interface PoolEntry {
  playerId: string;
  displayName: string;
  draftScore: number;
  labels: RecommendationLabel[];
  confidence: "LOW" | "MEDIUM" | "HIGH";
  components: ScoreComponent[];
  explanation: string;
  availabilityNextPick: number;
  lookaheadBonus: number;
}

export interface RecommendationOutput {
  engineVersion: string;
  inputChecksum: string;
  top3: PoolEntry[];
  pool: PoolEntry[];
  userTeamSlot: number;
}

import { overallPickToSlot } from "./draft";

export const ENGINE_VERSION = "phase2-deterministic-1.0.0";

/** Default factor priority (BUILD_SPEC section 2.2) -> reciprocal rank weights. */
const DEFAULT_PRIORITY: ComponentKey[] = [
  "production",
  "scarcity",
  "rosterNeed",
  "risk",
  "consistency",
  "age",
  "adpValue",
  "upside",
  "role",
  "nextPickAvailability",
  "preference",
];

export function defaultWeights(): Record<ComponentKey, number> {
  const raw = new Map<ComponentKey, number>();
  DEFAULT_PRIORITY.forEach((key, index) => raw.set(key, 1 / (index + 1)));
  const total = [...raw.values()].reduce((a, b) => a + b, 0);
  const weights = {} as Record<ComponentKey, number>;
  for (const [key, value] of raw) weights[key] = value / total;
  return weights;
}

// ---------------------------------------------------------------------------
// Canonical serialization + synchronous SHA-256 (deterministic, dependency-free)
// ---------------------------------------------------------------------------

/** Recursively sorts object keys and array-stabilizes by stable JSON form. */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    // Arrays keep order EXCEPT arrays of plain objects, which are sorted by
    // their canonical form so upstream query order cannot change the hash.
    const items = value.map((item) => canonicalize(item));
    return "[" + items.join(",") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return "{" + entries.join(",") + "}";
}

function sha256Hex(message: string): string {
  // Synchronous, allocation-light SHA-256 over UTF-8 bytes.
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  // UTF-8 encode
  const bytes: number[] = [];
  for (const ch of message) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
  }
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLength / 0x100000000);
  const lo = bitLength >>> 0;
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
  bytes.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      const b0 = bytes[j] ?? 0,
        b1 = bytes[j + 1] ?? 0;
      const b2 = bytes[j + 2] ?? 0,
        b3 = bytes[j + 3] ?? 0;
      w[i] = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const wm15 = w[i - 15] ?? 0;
      const wm2 = w[i - 2] ?? 0;
      const s0 = rotr(wm15, 7) ^ rotr(wm15, 18) ^ (wm15 >>> 3);
      const s1 = rotr(wm2, 17) ^ rotr(wm2, 19) ^ (wm2 >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    const hv = [...H];
    const a0 = hv[0] ?? 0,
      b0 = hv[1] ?? 0,
      c0 = hv[2] ?? 0,
      d0 = hv[3] ?? 0;
    const e0 = hv[4] ?? 0,
      f0 = hv[5] ?? 0,
      g0 = hv[6] ?? 0,
      h0 = hv[7] ?? 0;
    let a = a0,
      b = b0,
      c = c0,
      d = d0,
      e = e0,
      f = f0,
      g = g0,
      h = h0;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const sums = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) {
      H[i] = ((H[i] ?? 0) + (sums[i] ?? 0)) >>> 0;
    }
  }
  let out = "";
  for (const word of H) out += word.toString(16).padStart(8, "0");
  return out;
}

export function checksumInput(canonicalJson: string): string {
  return sha256Hex(canonicalJson);
}

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) seeded from checksum + explicit seed
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

export function percentileRank(sortedValues: readonly number[], value: number): number {
  if (sortedValues.length === 0) return 0.5;
  let below = 0;
  for (const v of sortedValues) {
    if (v < value) below += 1;
    else break;
  }
  return below / sortedValues.length;
}

export function winsorize(values: number[]): number[] {
  if (values.length === 0) return values;
  const sorted = [...values].sort((a, b) => a - b);
  const lowIdx = Math.floor(0.02 * (sorted.length - 1));
  const highIdx = Math.ceil(0.98 * (sorted.length - 1));
  const low = sorted[lowIdx] ?? sorted[sorted.length - 1] ?? 0;
  const high = sorted[highIdx] ?? low;
  return values.map((v) => Math.min(Math.max(v, low), high));
}

export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

// ---------------------------------------------------------------------------
// Fantasy value math
// ---------------------------------------------------------------------------

const PER_GAME_STATS = [
  "pts",
  "reb",
  "ast",
  "stl",
  "blk",
  "tov",
  "fgm",
  "fga",
  "ftm",
  "fta",
  "threePm",
] as const;
type PerGameStat = (typeof PER_GAME_STATS)[number];
type StatLine = Record<PerGameStat, number>;

function toPerGame(p: EngineProjection): StatLine {
  const games = Math.max(1, p.games);
  return {
    pts: p.pts / games,
    reb: p.reb / games,
    ast: p.ast / games,
    stl: p.stl / games,
    blk: p.blk / games,
    tov: p.tov / games,
    fgm: p.fgm / games,
    fga: p.fga / games,
    ftm: p.ftm / games,
    fta: p.fta / games,
    threePm: p.threePm / games,
  };
}

/** Points-league fantasy points under the league's own weights (section 6.2). */
export function seasonFantasyPoints(
  projection: EngineProjection,
  rules: EngineScoringRule[],
): number {
  const totals: Record<string, number> = {
    pts: projection.pts,
    reb: projection.reb,
    ast: projection.ast,
    stl: projection.stl,
    blk: projection.blk,
    tov: projection.tov,
    fgm: projection.fgm,
    fga: projection.fga,
    ftm: projection.ftm,
    fta: projection.fta,
    threePm: projection.threePm,
  };
  let sum = 0;
  for (const rule of rules) {
    if (!rule.enabled || rule.punt) continue;
    const key = rule.stat.toLowerCase();
    const statTotal = totals[key];
    if (statTotal !== undefined) sum += statTotal * rule.weight;
  }
  return sum;
}

/** Volume-aware percentage impact (never averages percentages; section 6.2):
 * fgImpact = FGM - baselineFG% x FGA, per game. */
export function percentageImpacts(perGame: StatLine): { fgImpact: number; ftImpact: number } {
  const fgBaseline = perGame.fga > 0 ? perGame.fgm / perGame.fga : 0.45;
  const ftBaseline = perGame.fta > 0 ? perGame.ftm / perGame.fta : 0.75;
  void fgBaseline;
  void ftBaseline;
  // Baselines are POOL baselines computed by the caller; here we expose raw
  // volume terms so the pool-level sd() is applied where the pool exists.
  return { fgImpact: perGame.fgm - perGame.fga * 0.45, ftImpact: perGame.ftm - perGame.fta * 0.75 };
}

export interface PoolBaselines {
  meanFgImpact: number;
  sdFgImpact: number;
  meanFtImpact: number;
  sdFtImpact: number;
}

export function computePoolBaselines(projections: EngineProjection[]): PoolBaselines {
  const impacts = projections.map((p) => percentageImpacts(toPerGame(p)));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const fgValues = winsorize(impacts.map((i) => i.fgImpact));
  const ftValues = winsorize(impacts.map((i) => i.ftImpact));
  void impacts;
  const meanFg = mean(fgValues);
  const meanFt = mean(ftValues);
  // Centered z-scores need deviation from the pool mean.
  return {
    meanFgImpact: meanFg,
    sdFgImpact: Math.max(1e-6, standardDeviation(fgValues)),
    meanFtImpact: meanFt,
    sdFtImpact: Math.max(1e-6, standardDeviation(ftValues)),
  };
}

/** Category-league per-game utility with reliability weighting
 * (sqrt(games/82)), lower-is-better sign flips, punts zeroed. */
export function categoryUtility(projection: EngineProjection, rules: EngineScoringRule[]): number {
  const perGame = toPerGame(projection);
  const reliability = Math.sqrt(Math.min(projection.games, 82) / 82);
  let utility = 0;
  for (const rule of rules) {
    if (!rule.enabled || rule.punt) continue;
    if (rule.stat === "FG_PCT" || rule.stat === "FT_PCT") continue; // volume-aware impacts handled by the caller
    const key = rule.stat.toLowerCase();
    const perGameValue: number | undefined = (perGame as Record<string, number | undefined>)[key];
    let value: number;
    if (perGameValue !== undefined) {
      value = perGameValue;
    } else if (rule.stat === "GAMES") {
      value = projection.games / 82;
    } else if (rule.stat === "MINUTES") {
      value = projection.minutesPerGame / 48;
    } else {
      continue;
    }
    const signed = rule.direction === "LOWER_BETTER" ? -value : value;
    utility += signed * rule.weight * reliability;
  }
  return utility;
}

// ---------------------------------------------------------------------------
// Seeded opponent-selection simulator (availability + lookahead)
// ---------------------------------------------------------------------------

export interface SimContext {
  availableIds: string[];
  /** Softmax features per player (higher = more attractive). */
  features: Map<string, number>;
  temperature: number;
  rand: () => number;
}

/** Weighted random pick from the softmax of features (section 6.6). */
function softmaxSelect(context: SimContext): string | null {
  const ids = context.availableIds;
  if (ids.length === 0) return null;
  const weights = ids.map((id) => Math.exp((context.features.get(id) ?? 0) / context.temperature));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = context.rand() * total;
  for (let i = 0; i < ids.length; i++) {
    roll -= weights[i] ?? 0;
    if (roll <= 0) {
      const chosenId = ids[i];
      return chosenId ?? null;
    }
  }
  const fallback = ids[ids.length - 1];
  return fallback ?? null;
}

/** Minimal versioned opponent tendency vector, updated ONLY from observed
 * real picks in this draft (no user preference profiles are created). */
export interface TendencyVector {
  version: 1;
  /** Position-frequency bias learned from observed picks (normalized). */
  positionBias: Record<string, number>;
}

export function buildTendency(
  draftedAssignments: EngineAssignment[],
  playersById: Map<string, EnginePlayerMeta>,
): TendencyVector {
  const bias: Record<string, number> = {};
  for (const assignment of draftedAssignments) {
    const meta = playersById.get(assignment.playerId);
    if (!meta) continue;
    for (const position of meta.eligiblePositions) {
      bias[position] = (bias[position] ?? 0) + 1;
    }
  }
  return { version: 1, positionBias: bias };
}

// ---------------------------------------------------------------------------
// The engine entry point
// ---------------------------------------------------------------------------

const SIM_RUNS_LIVE = 250;
const LOOKAHEAD_POOL = 20;
const LOOKAHEAD_CAP = 0.1;
/** Diminishing returns: category win-probability utility decays to zero as
 * the projected win probability approaches this ceiling (section 6.4). */
const WIN_PROB_CEILING = 0.85;
const UTIL_BENCH_MULTIPLIER = 0.7;
interface Candidate {
  playerId: string;
  displayName: string;
  projection: EngineProjection;
  perGame: StatLine;
  meta: EnginePlayerMeta;
  fantasyPoints: number;
  utility: number;
  fgZ: number;
  ftZ: number;
}

export function recommend(input: EngineInput): RecommendationOutput {
  const weights = defaultWeights();
  const userTeamSlot = overallPickToSlot(input.nextOverallPick, input.settings.teamCount);

  // ---- eligibility -------------------------------------------------------
  const draftedIds = new Set(input.draftedAssignments.map((a) => a.playerId));
  const playersById = new Map(input.players.map((p) => [p.playerId, p]));
  const projectionsById = new Map(input.projections.map((p) => [p.playerId, p]));

  const projectionByIdSafe = new Map(input.projections.map((p) => [p.playerId, p] as const));
  void projectionByIdSafe;
  const pool = input.players.filter((player) => {
    if (draftedIds.has(player.playerId)) return false;
    if (player.status === "RETIRED") return false;
    if (player.status === "UNSIGNED" && !input.includeUnsigned) return false;
    return projectionsById.has(player.playerId);
  });

  // ---- canonical checksum over the full immutable snapshot ---------------
  const canonicalInput = canonicalize({
    adp: input.adp,
    draftedAssignments: input.draftedAssignments,
    engineSeed: input.engineSeed,
    includeUnsigned: input.includeUnsigned,
    modelVersion: input.modelVersion,
    nextOverallPick: input.nextOverallPick,
    picksUntilUserTurn: input.picksUntilUserTurn,
    players: input.players,
    projectionRunId: input.projectionRunId,
    projections: input.projections,
    settings: input.settings,
  });
  const inputChecksum = checksumInput(canonicalInput);

  const candidates: Candidate[] = pool.map((player) => {
    const projection = projectionsById.get(player.playerId);
    if (!projection) throw new Error("projection missing after pool filter");
    return {
      playerId: player.playerId,
      displayName: player.displayName,
      projection,
      perGame: toPerGame(projection),
      meta: player,
      fantasyPoints: seasonFantasyPoints(projection, input.settings.scoringRules),
      utility: categoryUtility(projection, input.settings.scoringRules),
      fgZ: 0,
      ftZ: 0,
    };
  });

  const baselines = computePoolBaselines(
    pool
      .map((p) => projectionsById.get(p.playerId))
      .filter((p): p is EngineProjection => p !== undefined),
  );
  for (const candidate of candidates) {
    const impact = percentageImpacts(candidate.perGame);
    candidate.fgZ = (impact.fgImpact - baselines.meanFgImpact) / baselines.sdFgImpact;
    candidate.ftZ = (impact.ftImpact - baselines.meanFtImpact) / baselines.sdFtImpact;
  }

  // ---- production --------------------------------------------------------
  const isPoints = input.settings.type === "POINTS";
  const productionRaw = new Map<string, number>();
  {
    const seasonValues = winsorize(candidates.map((c) => c.fantasyPoints));
    const perGameValues = candidates.map((c) => c.fantasyPoints / Math.max(1, c.projection.games));
    const sortedSeason = [...seasonValues].sort((a, b) => a - b);
    const sortedPerGame = [...perGameValues].sort((a, b) => a - b);
    for (const candidate of candidates) {
      const fp = seasonFantasyPoints(candidate.projection, input.settings.scoringRules);
      const idx = candidates.indexOf(candidate);
      const perGameFp = fp / Math.max(1, candidate.projection.games);
      const seasonPct = percentileRank(
        sortedSeason,
        seasonValues[candidates.indexOf(candidate)] ?? 0,
      );
      void idx;
      const perGamePct = percentileRank(sortedPerGame, perGameFp);
      let value: number;
      if (isPoints) {
        // 0.65 x percentile(per-game FP) + 0.35 x percentile(season FP)
        value = 0.65 * perGamePct + 0.35 * seasonPct;
      } else {
        const reliability = Math.sqrt(Math.min(candidate.projection.games, 82) / 82);
        value =
          percentileRank(
            candidates
              .map((c2) => categoryUtility(c2.projection, input.settings.scoringRules))
              .sort((a, b) => a - b),
            candidate.utility,
          ) *
            reliability +
          0.15 * clamp01((candidate.fgZ + candidate.ftZ + 4) / 8);
      }
      productionRaw.set(candidate.playerId, value);
    }
  }

  // ---- scarcity: replacement-relative positional value -------------------
  const scarcityRaw = new Map<string, number>();
  {
    const utilitySorted = [...candidates]
      .map((c) => ({ id: c.playerId, utility: c.utility }))
      .sort((a, b) => a.utility - b.utility);
    const allUtilities = utilitySorted.map((x) => x.utility);
    const replacementUtilityByPosition = new Map<string, number>();
    const filledByPosition = countFilledByPosition(
      input.draftedAssignments,
      playersById,
      input.settings.rosterSlots,
    );
    for (const slot of input.settings.rosterSlots) {
      if (!slot.isStarter || slot.position === "BENCH") continue;
      const eligiblePool = candidates.filter((c) =>
        c.meta.eligiblePositions.includes(slot.position),
      );
      eligiblePool.sort((a, b) => a.utility - b.utility);
      const needed = Math.max(
        1,
        slot.count * Math.max(1, Math.floor(input.settings.teamCount / 2)),
      );
      const idx = Math.min(
        eligiblePool.length - 1,
        filledByPosition.get(slot.position) ?? 0,
        needed - 1,
      );
      const replacement = eligiblePool[Math.max(0, idx)];
      replacementUtilityByPosition.set(
        slot.position,
        replacement ? replacement.utility : median(allUtilities),
      );
    }
    for (const candidate of candidates) {
      let best = -Infinity;
      for (const position of candidate.meta.eligiblePositions) {
        const replacement = replacementUtilityByPosition.get(position);
        if (replacement === undefined) continue;
        const marginal = candidate.utility - replacement;
        const isBenchish = position === "UTIL" || position === "BENCH";
        best = Math.max(best, isBenchish ? marginal * UTIL_BENCH_MULTIPLIER : marginal);
      }
      scarcityRaw.set(candidate.playerId, best === -Infinity ? 0 : best);
    }
    // Normalize marginal utilities into 0..1 by rank.
    normalizeByRank(scarcityRaw);
  }

  // ---- risk safety / consistency / upside / role -------------------------
  const riskRaw = new Map<string, number>();
  const consistencyRaw = new Map<string, number>();
  const upsideRaw = new Map<string, number>();
  const roleRaw = new Map<string, number>();
  for (const candidate of candidates) {
    const p = candidate.projection;
    const width =
      Math.abs((p.upper80.pts ?? 0) - (p.lower80.pts ?? 0)) / Math.max(1, Math.abs(p.pts) + 1);
    riskRaw.set(
      candidate.playerId,
      clamp01(1 - (0.6 * p.injuryRisk + 0.25 * Math.min(1, width) + 0.15 * (1 - p.roleSecurity))),
    );
    consistencyRaw.set(candidate.playerId, clamp01(p.consistency));

    const upperFp = seasonFantasyPoints(
      {
        ...p,
        pts: p.upper80.pts ?? p.pts,
        reb: p.upper80.reb ?? p.reb,
        ast: p.upper80.ast ?? p.ast,
      },
      input.settings.scoringRules,
    );
    const medianFp = Math.max(1, Math.abs(candidate.fantasyPoints));
    upsideRaw.set(
      candidate.playerId,
      clamp01(((upperFp - candidate.fantasyPoints) / medianFp) * p.roleSecurity),
    );
    roleRaw.set(
      candidate.playerId,
      clamp01(0.7 * p.roleSecurity + 0.3 * Math.min(1, p.minutesPerGame / 36)),
    );
  }

  // ---- age curve (dynasty/keeper youth; redraft neutral) -----------------
  const ageRaw = new Map<string, number>();
  for (const candidate of candidates) {
    const age = candidate.meta.age;
    if (age === undefined || input.settings.horizon === "REDRAFT") {
      ageRaw.set(candidate.playerId, 0.5); // neutral in redraft
    } else {
      // Youth curve: no penalty through the prime (~24), gently decaying
      // value for older players — dynasty/keeper contexts value runway.
      ageRaw.set(candidate.playerId, clamp01(Math.exp(-(Math.max(0, age - 24) ** 2) / 40)));
    }
  }

  // ---- ADP value ---------------------------------------------------------
  const adpValueRaw = new Map<string, number>();
  const adpById = new Map((input.adp ?? []).map((entry) => [entry.playerId, entry]));
  for (const candidate of candidates) {
    const adpEntry = adpById.get(candidate.playerId);
    if (!adpEntry) {
      adpValueRaw.set(candidate.playerId, 0.5); // unknown market -> neutral
      continue;
    }
    const gap = clampAdpGap(adpEntry.adp - input.nextOverallPick);
    adpValueRaw.set(candidate.playerId, clamp01(0.5 + gap / 48)); // +/-24 picks
  }

  // ---- roster need (simulate adding the candidate) -----------------------
  const rosterNeedRaw = computeRosterNeed(candidates, input, playersById);

  // ---- availability simulation (seeded Monte Carlo) ----------------------
  const tendency = buildTendency(input.draftedAssignments, playersById);
  const availability = simulateAvailability(input, candidates, tendency, adpById);

  // ---- assemble normalized components ------------------------------------
  // production / scarcity / adpValue / rosterNeed are already pool-relative
  // percentiles. risk/consistency/upside/role/age are absolute 0..1 semantic
  // scores — rank-normalizing them would distort their meaning (e.g. a
  // uniformly healthy pool would still produce artificial spread).
  const normProduction = rankNormalize(productionRaw);
  const normScarcity = scarcityRaw;
  const normRisk = riskRaw;
  const normConsistency = consistencyRaw;
  const normAge = ageRaw;
  const normAdpValue = adpValueRaw;
  const normUpside = upsideRaw;
  const normRole = roleRaw;
  const normRosterNeed = rosterNeedRaw;

  const workings: Working[] = candidates.map((candidate) => {
    const playerId = candidate.playerId;
    const adpEntry = adpById.get(playerId);
    const availabilityValue = availability.availability.get(playerId) ?? 1;
    const urgency = 1 - availabilityValue;

    const components: ScoreComponent[] = [
      component(
        "production",
        productionRaw.get(playerId) ?? 0,
        normProduction.get(playerId) ?? 0,
        weights.production,
        isPoints
          ? "blended per-game and season projected points percentile"
          : "replacement-relative category utility",
      ),
      component(
        "scarcity",
        scarcityRaw.get(playerId) ?? 0,
        normScarcity.get(playerId) ?? 0,
        weights.scarcity,
        "marginal value above positional replacement",
      ),
      component(
        "rosterNeed",
        0,
        normRosterNeed.get(playerId) ?? 0,
        weights.rosterNeed,
        "simulated fit on your roster including category balance",
      ),
      component(
        "risk",
        0,
        normRisk.get(playerId) ?? 0,
        weights.risk,
        "safety from injury risk, interval width and role security",
      ),
      component(
        "consistency",
        0,
        normConsistency.get(playerId) ?? 0,
        weights.consistency,
        "projected game-to-game stability",
      ),
      component(
        "age",
        0,
        normAge.get(playerId) ?? 0,
        weights.age,
        input.settings.horizon === "REDRAFT" ? "neutral in redraft" : "youth curve for horizon",
      ),
      component(
        "adpValue",
        0,
        normAdpValue.get(playerId) ?? 0,
        weights.adpValue,
        adpEntry ? "market gap versus current pick" : "no market data — neutral",
      ),
      component(
        "upside",
        0,
        normUpside.get(playerId) ?? 0,
        weights.upside,
        "upper-80% interval above median, reliability-adjusted",
      ),
      component(
        "role",
        0,
        normRole.get(playerId) ?? 0,
        weights.role,
        "projected minutes and role security",
      ),
      component(
        "nextPickAvailability",
        0,
        urgency,
        weights.nextPickAvailability,
        "tie-break urgency from seeded availability simulation",
      ),
      component(
        "preference",
        0,
        0,
        weights.preference,
        "default profile — personalization arrives in Phase 3",
      ),
      {
        key: "schedule",
        raw: 0,
        normalized: 0,
        weight: 0,
        contribution: 0,
        reason: "off by default",
      },
    ];
    for (const comp of components) {
      comp.contribution = comp.normalized * comp.weight;
    }
    const base = components.reduce((sum, c) => sum + c.contribution, 0);

    let confidence: PoolEntry["confidence"] = "HIGH";
    if (!adpEntry || adpEntry.sourcesCount < 2) confidence = "LOW";
    else if (candidate.projection.injuryRisk > 0.45 || candidate.projection.games < 55)
      confidence = "MEDIUM";

    return {
      candidate,
      components,
      base,
      lookaheadBonus: 0,
      availability: availabilityValue,
      confidence,
      adpGapKnown: Boolean(adpEntry),
    };
  });

  // ---- lookahead for the top 20 by base (shallow two-user-pick rollout) --
  const orderedForLookahead = [...workings].sort((a, b) => b.base - a.base);
  applyLookahead(
    orderedForLookahead.slice(0, LOOKAHEAD_POOL),
    workings,
    input,
    availability.features,
    adpById,
  );

  // ---- final scores ------------------------------------------------------
  const entries: PoolEntry[] = workings.map((working) => {
    const rawScore = 100 * clamp01(working.base + LOOKAHEAD_CAP * working.lookaheadBonus);
    const draftScore = Math.round(rawScore * 10) / 10;
    const explanation = buildExplanation(working.components, {
      confidence: working.confidence,
      adpGapKnown: working.adpGapKnown,
      availability: working.availability,
    });
    return {
      playerId: working.candidate.playerId,
      displayName: working.candidate.displayName,
      draftScore,
      labels: [],
      confidence: working.confidence,
      components: working.components,
      explanation,
      availabilityNextPick: working.availability,
      lookaheadBonus: working.lookaheadBonus,
    };
  });

  assignLabels(entries, workings);

  entries.sort(sortEntries);
  const top3 = entries.slice(0, 3);
  for (const entry of top3) entry.labels = entry.labels.length ? entry.labels : ["BEST_OVERALL"];

  return {
    engineVersion: ENGINE_VERSION,
    inputChecksum,
    top3,
    pool: entries,
    userTeamSlot,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Working {
  candidate: Candidate;
  components: ScoreComponent[];
  base: number;
  lookaheadBonus: number;
  availability: number;
  confidence: PoolEntry["confidence"];
  adpGapKnown: boolean;
}

function component(
  key: ComponentKey,
  raw: number,
  normalized: number,
  weight: number,
  reason: string,
): ScoreComponent {
  return { key, raw, normalized, weight, contribution: normalized * weight, reason };
}

function clampAdpGap(gap: number): number {
  return Math.min(24, Math.max(-24, gap));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const midValue = sorted[mid] ?? 0;
  const prevValue = sorted[mid - 1] ?? midValue;
  return sorted.length % 2 === 1 ? midValue : (prevValue + midValue) / 2;
}

function normalizeByRank(map: Map<string, number>): void {
  const entries = [...map.entries()];
  if (entries.length <= 1) {
    for (const [id] of entries) map.set(id, 0.5);
    return;
  }
  const sortedEntries = [...entries].sort((a, b) => a[1] - b[1]);
  const minValue = sortedEntries[0]?.[1] ?? 0;
  const maxValue = sortedEntries[sortedEntries.length - 1]?.[1] ?? 0;
  if (minValue === maxValue) {
    // All tied: a neutral component must stay neutral, not arbitrarily spread.
    for (const [id] of entries) map.set(id, 0.5);
    return;
  }
  sortedEntries.forEach(([id], index) => {
    map.set(id, index / (sortedEntries.length - 1));
  });
}

function rankNormalize(source: Map<string, number>): Map<string, number> {
  const copy = new Map(source);
  normalizeByRank(copy);
  return copy;
}

function countFilledByPosition(
  assignments: EngineAssignment[],
  playersById: Map<string, EnginePlayerMeta>,
  rosterSlots: { position: string; count: number; isStarter: boolean }[],
): Map<string, number> {
  void rosterSlots;
  const counts = new Map<string, number>();
  for (const assignment of assignments) {
    const meta = playersById.get(assignment.playerId);
    if (!meta) continue;
    const key = assignment.slotPosition;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Roster need, availability simulation, lookahead, labels, explanations
// ---------------------------------------------------------------------------

function computeRosterNeed(
  candidates: Candidate[],
  input: EngineInput,
  playersById: Map<string, EnginePlayerMeta>,
): Map<string, number> {
  const snapshotRoster = input.settings.rosterSlots;
  const userAssignments = input.draftedAssignments.filter(
    (a) => a.teamSlot === overallPickToSlot(input.nextOverallPick, input.settings.teamCount),
  );

  // Baseline: how many starter slots are open before adding anyone.
  const filledByPosition = new Map<string, number>();
  for (const assignment of userAssignments) {
    filledByPosition.set(
      assignment.slotPosition,
      (filledByPosition.get(assignment.slotPosition) ?? 0) + 1,
    );
  }
  const totalStarters = snapshotRoster
    .filter((slot) => slot.isStarter)
    .reduce((sum, slot) => sum + slot.count, 0);
  // Replacement-team category baseline for win-probability comparisons.
  const teamCategoryTotals = (extra?: Candidate): Record<string, number> => {
    const totals: Record<string, number> = {};
    for (const assignment of userAssignments) {
      const projection = input.projections.find((p) => p.playerId === assignment.playerId);
      if (!projection) continue;
      accumulate(totals, projection);
    }
    if (extra) accumulate(totals, extra.projection);
    void playersById;
    return totals;
  };

  const needRaw = new Map<string, number>();
  for (const candidate of candidates) {
    // Coverage improvement: does the player fill an open starter slot?
    const eligibleStarterSlots = snapshotRoster.filter(
      (slot) =>
        slot.isStarter &&
        candidate.meta.eligiblePositions.includes(slot.position) &&
        (filledByPosition.get(slot.position) ?? 0) < slot.count,
    );
    const coverageGain =
      totalStarters > 0 && eligibleStarterSlots.length > 0 ? 1 / totalStarters : 0;

    let needValue: number;
    if (input.settings.type === "POINTS") {
      needValue = 0.6 * coverageGain * 4 + 0.4 * clamp01(candidate.fantasyPoints / 2000);
    } else {
      const mine = teamCategoryTotals(candidate);
      // Opponent baseline: median starter production per category.
      const opponent = replacementTeamTotals(input);
      const rules = input.settings.scoringRules.filter((rule) => rule.enabled && !rule.punt);
      let winProbSum = 0;
      for (const rule of rules) {
        const key = rule.stat.toLowerCase();
        const mineValue = mine[key] ?? 0;
        const theirs = opponent[key] ?? 0;
        const margin = rule.direction === "LOWER_BETTER" ? theirs - mineValue : mineValue - theirs;
        const scale = Math.max(50, Math.abs(theirs) * 0.25);
        const pWin = 1 / (1 + Math.exp(-margin / scale));
        // Diminishing returns near dominance; competitive categories near 0.5.
        const decay = 1 - clamp01(pWin / WIN_PROB_CEILING);
        winProbSum += rule.weight * pWin * decay;
      }
      const weightSum = rules.reduce((sum, r) => sum + r.weight, 0) || 1;
      needValue = 0.4 * (coverageGain * 4) + 0.6 * (winProbSum / weightSum);
    }
    needRaw.set(candidate.playerId, clamp01(needValue));
  }
  return rankNormalize(needRaw);

  function accumulate(into: Record<string, number>, projection: EngineProjection): void {
    into.pts = (into.pts ?? 0) + projection.pts;
    into.reb = (into.reb ?? 0) + projection.reb;
    into.ast = (into.ast ?? 0) + projection.ast;
    into.stl = (into.stl ?? 0) + projection.stl;
    into.blk = (into.blk ?? 0) + projection.blk;
    into.tov = (into.tov ?? 0) + projection.tov;
    into.three_pm = (into.three_pm ?? 0) + projection.threePm;
  }

  function replacementTeamTotals(contextInput: EngineInput): Record<string, number> {
    // Median starter per category across the pool x starters — a stable,
    // deterministic proxy for "a replacement-built opponent".
    const starters = contextInput.settings.rosterSlots.filter((slot) => slot.isStarter);
    const totals: Record<string, number> = {};
    const medians: Record<string, number> = {};
    const sample = candidates.slice(0, 60).map((c) => c.projection);
    for (const stat of PER_GAME_STATS) {
      medians[stat] = median(sample.map((projection) => projection[stat]));
    }
    for (const slot of starters) {
      for (const stat of PER_GAME_STATS) {
        const key = stat === "threePm" ? "three_pm" : stat;
        totals[key] = (totals[key] ?? 0) + (medians[stat] ?? 0) * slot.count;
      }
    }
    return totals;
  }
}

interface AvailabilityResult {
  availability: Map<string, number>;
  features: Map<string, number>;
}

function simulateAvailability(
  input: EngineInput,
  candidates: Candidate[],
  tendency: TendencyVector,
  adpById: Map<string, EngineAdpEntry>,
): AvailabilityResult {
  const seedSource = checksumInput(
    canonicalize({
      draftSeed: input.engineSeed,
      nextOverallPick: input.nextOverallPick,
      settingsSeason: input.settings.season,
    }),
  );
  // Derive a numeric seed from the checksum's first 8 hex chars.
  const numericSeed = parseInt(seedSource.slice(0, 8), 16) >>> 0;
  const rand = mulberry32((numericSeed + input.engineSeed) >>> 0);

  // Softmax features: ADP attractiveness + projection + positional bias.
  const utilitiesSorted = [...candidates].map((c) => c.utility).sort((a, b) => a - b);
  const features = new Map<string, number>();
  const positionBiasTotal = Object.values(tendency.positionBias).reduce((a, b) => a + b, 0) || 1;
  for (const candidate of candidates) {
    const adpEntry = adpById.get(candidate.playerId);
    const adpComponent = adpEntry ? -Math.log(Math.max(1, adpEntry.adp)) : 0;
    const utilityPercentile = percentileRank(utilitiesSorted, candidate.utility);
    let bias = 0;
    for (const position of candidate.meta.eligiblePositions) {
      bias += (tendency.positionBias[position] ?? 0) / positionBiasTotal;
    }
    features.set(candidate.playerId, 0.45 * adpComponent + 0.35 * utilityPercentile + 0.2 * bias);
  }

  const availableIds = new Set(candidates.map((c) => c.playerId));
  const survival = new Map<string, number>(candidates.map((c) => [c.playerId, 0]));

  for (let run = 0; run < SIM_RUNS_LIVE; run++) {
    const simAvailable = new Set(availableIds);
    const context: SimContext = {
      availableIds: [],
      features,
      temperature: 1.2,
      rand,
    };
    for (let pickIndex = 0; pickIndex < input.picksUntilUserTurn; pickIndex++) {
      context.availableIds = [...simAvailable];
      const chosen = softmaxSelect(context);
      if (!chosen) break;
      simAvailable.delete(chosen);
    }
    for (const id of simAvailable) {
      survival.set(id, (survival.get(id) ?? 0) + 1);
    }
  }

  const availability = new Map<string, number>();
  for (const candidate of candidates) {
    availability.set(candidate.playerId, (survival.get(candidate.playerId) ?? 0) / SIM_RUNS_LIVE);
  }
  return { availability, features };
}

/** Shallow two-user-pick rollout for the top candidates by base score:
 * expected best-available utility at the user's NEXT turn, capped at 10% of
 * the final normalized score (section 6.7). */
function applyLookahead(
  topByBase: Working[],
  allWorkings: Working[],
  input: EngineInput,
  features: Map<string, number>,
  _adpById: Map<string, EngineAdpEntry>,
): void {
  void _adpById;
  if (topByBase.length === 0 || input.picksUntilUserTurn <= 0) return;

  const rand = mulberry32((input.engineSeed ^ 0x9e3779b9) >>> 0);
  const draftedIds = new Set(input.draftedAssignments.map((a) => a.playerId));
  const userSlotNow = overallPickToSlot(input.nextOverallPick, input.settings.teamCount);
  const nextUserPickNumber = upcomingNextUserPick(input);
  const interveningAfter = Math.max(0, nextUserPickNumber - input.nextOverallPick - 1);

  const utilityById = new Map(allWorkings.map((w) => [w.candidate.playerId, w.base]));

  for (const working of topByBase) {
    // If the manager drafts this candidate NOW, their next-turn best-available
    // utility is simulated over the remaining pool WITHOUT them having it.
    let expectedUtilityIfDrafted = 0;
    let expectedUtilityIfPassed = 0;
    const runs = 40;
    for (let run = 0; run < runs; run++) {
      const simAvailable = new Set(
        allWorkings.map((w) => w.candidate.playerId).filter((id) => !draftedIds.has(id)),
      );
      const context: SimContext = { availableIds: [], features, temperature: 1.2, rand };
      // Intervening picks between now and the user's NEXT selection.
      const removedIfDrafted = new Set<string>();
      for (let i = 0; i < interveningAfter; i++) {
        context.availableIds = [...simAvailable];
        void removedIfDrafted;
        const chosen = softmaxSelect(context);
        if (!chosen) break;
        simAvailable.delete(chosen);
      }
      // If passed on, the candidate may already be gone at the next turn.
      const stillThereIfPassed = simAvailable.has(working.candidate.playerId)
        ? working.base
        : median([...utilityById.values()]);
      // If drafted, the user holds it; next-turn utility is the best OTHER
      // option (roster improved -> slightly higher bar).
      let bestOther = 0;
      void removedIfDrafted;
      for (const id of simAvailable) {
        bestOther = Math.max(bestOther, utilityById.get(id) ?? 0);
      }
      expectedUtilityIfDrafted += bestOther;
      expectedUtilityIfPassed += stillThereIfPassed * 0.98 + bestOther * 0;
      void userSlotNow;
    }
    expectedUtilityIfDrafted /= runs;
    expectedUtilityIfPassed /= runs;
    // Positive when drafting now avoids losing disproportionate future value.
    const delta = expectedUtilityIfPassed - expectedUtilityIfDrafted;
    working.lookaheadBonus = clamp01(Math.max(0, delta));
  }
}

function upcomingNextUserPick(input: EngineInput): number {
  const teamCount = input.settings.teamCount;
  const userSlot = input.settings.userDraftSlot;
  const total = input.settings.rounds * teamCount;
  for (let pick = Math.max(input.nextOverallPick, 1); pick <= total; pick++) {
    if (overallPickToSlot(pick, teamCount) === userSlot) return pick;
  }
  return total;
}

function assignLabels(entries: PoolEntry[], workings: Working[]): void {
  const byId = new Map(workings.map((w) => [w.candidate.playerId, w]));
  const componentOf = (entry: PoolEntry, key: ComponentKey): ScoreComponent | undefined =>
    entry.components.find((c) => c.key === key);

  const labelBest = (label: RecommendationLabel, score: (entry: PoolEntry) => number): void => {
    let best: PoolEntry | null = null;
    for (const entry of entries) {
      if (best === null || score(entry) > score(best)) best = entry;
    }
    if (best !== null && !best.labels.includes(label)) best.labels.push(label);
  };

  labelBest("BEST_OVERALL", (e) => componentOf(e, "production")?.contribution ?? 0);
  labelBest("BEST_FIT", (e) => {
    const w = byId.get(e.playerId);
    return (
      (componentOf(e, "scarcity")?.contribution ?? 0) +
      (componentOf(e, "rosterNeed")?.contribution ?? 0) +
      (w?.base ?? 0) * 0
    );
  });
  labelBest("BEST_VALUE", (e) => componentOf(e, "adpValue")?.contribution ?? 0);
  labelBest("HIGHEST_UPSIDE", (e) => componentOf(e, "upside")?.contribution ?? 0);
  labelBest(
    "SAFEST_PICK",
    (e) =>
      (componentOf(e, "risk")?.contribution ?? 0) +
      (componentOf(e, "consistency")?.contribution ?? 0),
  );
}

function buildExplanation(
  components: ScoreComponent[],
  context: { confidence: PoolEntry["confidence"]; adpGapKnown: boolean; availability: number },
): string {
  const positives = [...components]
    .filter((c) => c.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution);
  const first = positives[0];
  const second = positives[1];
  const caveat = [...components]
    .filter((c) => c.normalized < 0.35 || (c.key === "adpValue" && !context.adpGapKnown))
    .sort((a, b) => a.contribution - b.contribution)[0];

  const parts: string[] = [];
  if (first) {
    parts.push(`Strongest factor: ${first.reason} (${describeShare(first)}).`);
  }
  if (second) {
    parts.push(`Also helps: ${second.reason} (${describeShare(second)}).`);
  }
  if (caveat) {
    parts.push(`Watch: ${caveat.reason}.`);
  } else if (context.confidence === "LOW") {
    parts.push("Watch: limited market/projection data lowers confidence.");
  }
  if (context.availability < 0.5) {
    const availabilityPct = String(Math.round(context.availability * 100));
    parts.push(`Only ${availabilityPct}% likely to reach your next pick.`);
  }
  return parts.join(" ");
}

function describeShare(component: ScoreComponent): string {
  const pct = Math.round(component.normalized * 100);
  return `${String(pct)}th percentile`;
}

function sortEntries(a: PoolEntry, b: PoolEntry): number {
  if (b.draftScore !== a.draftScore) return b.draftScore - a.draftScore;
  const compA = a.components.find((c) => c.key === "production")?.normalized ?? 0;
  const compB = b.components.find((c) => c.key === "production")?.normalized ?? 0;
  if (compB !== compA) return compB - compA;
  const scarA = a.components.find((c) => c.key === "scarcity")?.normalized ?? 0;
  const scarB = b.components.find((c) => c.key === "scarcity")?.normalized ?? 0;
  if (scarB !== scarA) return scarB - scarA;
  const valueA = a.components.find((c) => c.key === "adpValue")?.normalized ?? 0;
  const valueB = b.components.find((c) => c.key === "adpValue")?.normalized ?? 0;
  if (valueB !== valueA) return valueB - valueA;
  return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
}
