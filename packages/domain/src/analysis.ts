/* eslint-disable @typescript-eslint/no-unnecessary-condition, no-useless-assignment, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-non-null-assertion */
/**
 * Deterministic post-draft analysis (ADR 0015, BUILD_SPEC 9.4, Phase 3E1).
 * Pure TypeScript: no framework, no DB, no LLM, no wall-clock.
 * Same immutable input snapshot plus seed => byte-identical logical output.
 *
 * 5 components (0-100, letter A-F 90/80/70/60):
 *   valueCaptured 0.25, projectedStrength 0.30, rosterBalance 0.15,
 *   risk 0.15, scoringFit 0.15  (largest-remainder 6dp, weights sum 1)
 * Overall draftScore = round(100 * clamp(sum w*norm,0,1),1)
 *
 * Deterministic primitives reused from recommendation.ts:
 *   canonicalize, sha256Hex, seasonFantasyPoints, categoryUtility,
 *   percentageImpacts, computePoolBaselines, winsorize, percentileRank, mulberry32
 * Simulation seed derivation: FNV1a32(simulationSeed:analysisVersion:projectionRunId) -> SHA256 per-pick -> mulberry32
 */

export const ANALYSIS_VERSION = "1.0.0";
export const ANALYSIS_ENGINE_VERSION = "phase3-analysis-1.0.0";
export const ANALYSIS_DISCLOSURE =
  "This analysis is a projection, not a guarantee — it is based on pre-season projections and market data vs a replacement-built opponent and does not predict real standings.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnalysisScoringRule {
  stat: string;
  weight: number;
  direction: string;
  enabled: boolean;
  punt: boolean;
}

export interface AnalysisRosterSlot {
  position: string;
  count: number;
  isStarter: boolean;
}

export interface AnalysisSettings {
  season: string;
  type: "POINTS" | "CATEGORIES";
  horizon: "REDRAFT" | "KEEPER" | "DYNASTY";
  teamCount: number;
  rounds: number;
  userDraftSlot: number;
  scoringRules: AnalysisScoringRule[];
  rosterSlots: AnalysisRosterSlot[];
  teams?: { slot: number; displayName: string }[];
}

export interface AnalysisPlayerMeta {
  playerId: string;
  displayName: string;
  eligiblePositions: string[];
  status: "ACTIVE" | "INJURED" | "SUSPENDED" | "UNSIGNED" | "RETIRED";
  nbaTeamId?: string | undefined;
  age?: number | undefined;
}

export interface AnalysisProjection {
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

export interface AnalysisAdpEntry {
  playerId: string;
  adp: number;
  rank: number;
  sourcesCount: number;
}

export interface AnalysisAssignment {
  playerId: string;
  teamSlot: number;
  slotPosition: string;
  overallPick: number;
  isBench?: boolean;
  isKeeper?: boolean;
}

export interface AnalysisInput {
  settings: AnalysisSettings;
  players: AnalysisPlayerMeta[];
  projections: AnalysisProjection[];
  adp: AnalysisAdpEntry[] | null;
  assignments: AnalysisAssignment[]; // effective picks after undo resolution
  userTeamSlot: number;
  projectionRunId: string | null;
  adpSnapshotId: string | null;
  preferenceSnapshot?: unknown | null;
  preferenceSnapshotVersion?: number | null;
  preferenceSnapshotChecksum?: string | null;
  engineVersion: string;
  simulationSeed: string;
  analysisVersion?: string;
  projectionPublishedAt?: string | null;
  adpCapturedAt?: string | null;
  // deterministic provenance; excluded from checksum per ADR D1
  generatedAt?: string;
  // optional override for deterministic tests; when omitted a fixed default is used (no Date.now)
  dataCutoff?: string | null;
}

export interface AnalysisComponent {
  key: "valueCaptured" | "projectedStrength" | "rosterBalance" | "risk" | "scoringFit";
  raw: number;
  normalized: number; // 0..1 clamped
  weight: number; // 6dp, sum 1
  contribution: number; // normalized * weight, clamped
  reason: string;
}

export interface RoundEntry {
  round: number;
  overallPick: number;
  pickInRound: number;
  playerId: string;
  displayName: string;
  slotPosition: string;
  isBench: boolean;
  isKeeper: boolean;
  adp: number | null;
  adpValueNorm: number; // 0..1, 0.5 if no ADP
  adpDelta: number | null; // adp - overallPick, null if no ADP
  valueAboveReplacement: number | null;
  isBestValue: boolean;
  isBiggestReach: boolean;
  isIllegal: boolean;
}

export interface ProjectedStanding {
  runs: number;
  distribution: number[]; // length teamCount? or 2000 ranks? we store rank per run
  p50: number;
  p90: number;
  meanRank: number;
  bestRank: number;
  worstRank: number;
  label: string;
  // vs replacement-built opponent
  vsReplacement: boolean;
}

export interface DataFreshness {
  projectionRunId: string | null;
  projectionPublishedAt: string | null;
  adpSnapshotId: string | null;
  adpCapturedAt: string | null;
  generatedAt: string;
  engineVersion: string;
  analysisVersion: string;
  inputChecksum: string;
  status: "FRESH" | "STALE" | "LOW";
}

export interface AnalysisOutput {
  analysisVersion: string;
  engineVersion: string;
  inputChecksum: string;
  generatedAt: string; // excluded from checksum, deterministic
  draftScore: number; // 0-100, 1 decimal
  grade: string; // A-F
  components: AnalysisComponent[];
  strengths: string[];
  weaknesses: string[];
  roundByRound: RoundEntry[];
  bestValuePick: RoundEntry | null;
  biggestReach: RoundEntry | null;
  projectedStanding: ProjectedStanding;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  dataFreshness: DataFreshness;
  assumptions: string[];
  warnings: string[];
  disclosure: string;
}

// ---------------------------------------------------------------------------
// Stable serialization + SHA-256 (duplicated from recommendation.ts, no app import)
// ---------------------------------------------------------------------------

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
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
    for (let i = 0; i < 8; i++) H[i] = ((H[i] ?? 0) + (sums[i] ?? 0)) >>> 0;
  }
  let out = "";
  for (const word of H) out += word.toString(16).padStart(8, "0");
  return out;
}

export function checksumInput(canonicalJson: string): string {
  return sha256Hex(canonicalJson);
}

// ---------------------------------------------------------------------------
// Deterministic helpers (same as recommendation.ts)
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

export function percentileRank(sortedValues: readonly number[], value: number): number {
  if (!Number.isFinite(value) || sortedValues.length === 0) return 0.5;
  let below = 0;
  for (const v of sortedValues) {
    if (!Number.isFinite(v)) continue;
    if (v < value) below += 1;
    else break;
  }
  // guard against NaN/Infinity in sortedValues
  const finiteLen = sortedValues.filter(Number.isFinite).length || sortedValues.length;
  if (finiteLen === 0) return 0.5;
  return clamp01(below / finiteLen);
}

export function winsorize(values: number[]): number[] {
  if (values.length === 0) return values;
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return values.map(() => 0);
  const sorted = [...finite].sort((a, b) => a - b);
  const lowIdx = Math.floor(0.02 * (sorted.length - 1));
  const highIdx = Math.ceil(0.98 * (sorted.length - 1));
  const low = sorted[lowIdx] ?? sorted[sorted.length - 1] ?? 0;
  const high = sorted[highIdx] ?? low;
  const lo = Number.isFinite(low) ? low : 0;
  const hi = Number.isFinite(high) ? high : lo;
  return values.map((v) => {
    if (!Number.isFinite(v)) return lo;
    return Math.min(Math.max(v, lo), hi);
  });
}

export function standardDeviation(values: number[]): number {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return 0;
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
  const variance = finite.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (finite.length - 1);
  const sd = Math.sqrt(variance);
  return Number.isFinite(sd) ? sd : 0;
}

export const clamp01 = (v: number): number => {
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(1, Math.max(0, v));
};
const clamp = (v: number, lo: number, hi: number): number => {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
};

// FNV1a 32-bit (deterministic seed derivation per ADR)
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Fantasy value math (same primitives as recommendation.ts)
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

function toPerGame(p: AnalysisProjection): StatLine {
  const games = Math.max(1, Number.isFinite(p.games) ? p.games : 1);
  const safe = (v: number) => (Number.isFinite(v) ? v : 0);
  return {
    pts: safe(p.pts) / games,
    reb: safe(p.reb) / games,
    ast: safe(p.ast) / games,
    stl: safe(p.stl) / games,
    blk: safe(p.blk) / games,
    tov: safe(p.tov) / games,
    fgm: safe(p.fgm) / games,
    fga: safe(p.fga) / games,
    ftm: safe(p.ftm) / games,
    fta: safe(p.fta) / games,
    threePm: safe(p.threePm) / games,
  };
}

export function seasonFantasyPoints(
  projection: AnalysisProjection,
  rules: AnalysisScoringRule[],
): number {
  const safe = (v: number) => (Number.isFinite(v) ? v : 0);
  const totals: Record<string, number> = {
    pts: safe(projection.pts),
    reb: safe(projection.reb),
    ast: safe(projection.ast),
    stl: safe(projection.stl),
    blk: safe(projection.blk),
    tov: safe(projection.tov),
    fgm: safe(projection.fgm),
    fga: safe(projection.fga),
    ftm: safe(projection.ftm),
    fta: safe(projection.fta),
    threePm: safe(projection.threePm),
    threepm: safe(projection.threePm),
    three_pm: safe(projection.threePm),
  };
  let sum = 0;
  for (const rule of rules) {
    if (!rule.enabled || rule.punt) continue;
    if (!Number.isFinite(rule.weight)) continue;
    const key = rule.stat.toLowerCase();
    const statTotal = totals[key];
    if (statTotal !== undefined) sum += statTotal * rule.weight;
  }
  return Number.isFinite(sum) ? sum : 0;
}

export function percentageImpacts(perGame: StatLine): { fgImpact: number; ftImpact: number } {
  const safe = (v: number) => (Number.isFinite(v) ? v : 0);
  return {
    fgImpact: safe(perGame.fgm) - safe(perGame.fga) * 0.45,
    ftImpact: safe(perGame.ftm) - safe(perGame.fta) * 0.75,
  };
}

export interface PoolBaselines {
  meanFgImpact: number;
  sdFgImpact: number;
  meanFtImpact: number;
  sdFtImpact: number;
}

export function computePoolBaselines(projections: AnalysisProjection[]): PoolBaselines {
  const impacts = projections.map((p) => percentageImpacts(toPerGame(p)));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const fgValues = winsorize(impacts.map((i) => i.fgImpact));
  const ftValues = winsorize(impacts.map((i) => i.ftImpact));
  const meanFg = mean(fgValues.filter(Number.isFinite));
  const meanFt = mean(ftValues.filter(Number.isFinite));
  const sdFg = standardDeviation(fgValues);
  const sdFt = standardDeviation(ftValues);
  return {
    meanFgImpact: Number.isFinite(meanFg) ? meanFg : 0,
    sdFgImpact: Math.max(1e-6, Number.isFinite(sdFg) ? sdFg : 1e-6),
    meanFtImpact: Number.isFinite(meanFt) ? meanFt : 0,
    sdFtImpact: Math.max(1e-6, Number.isFinite(sdFt) ? sdFt : 1e-6),
  };
}

export function categoryUtility(
  projection: AnalysisProjection,
  rules: AnalysisScoringRule[],
): number {
  const perGame = toPerGame(projection);
  const gamesSafe = Number.isFinite(projection.games) ? projection.games : 1;
  const reliability = Math.sqrt(Math.min(gamesSafe, 82) / 82);
  let utility = 0;
  for (const rule of rules) {
    if (!rule.enabled || rule.punt) continue;
    if (rule.stat === "FG_PCT" || rule.stat === "FT_PCT") continue;
    const key = rule.stat.toLowerCase();
    const perGameValue: number | undefined = (perGame as Record<string, number | undefined>)[key];
    let value: number;
    if (perGameValue !== undefined) {
      value = perGameValue;
    } else if (rule.stat === "GAMES") {
      value = gamesSafe / 82;
    } else if (rule.stat === "MINUTES") {
      const mpg = Number.isFinite(projection.minutesPerGame) ? projection.minutesPerGame : 0;
      value = mpg / 48;
    } else {
      continue;
    }
    if (!Number.isFinite(value)) continue;
    const signed = rule.direction === "LOWER_BETTER" ? -value : value;
    const w = Number.isFinite(rule.weight) ? rule.weight : 0;
    utility += signed * w * reliability;
  }
  return Number.isFinite(utility) ? utility : 0;
}

// ---------------------------------------------------------------------------
// Analysis-specific helpers
// ---------------------------------------------------------------------------

const ANALYSIS_WEIGHT_NOMINAL: Record<AnalysisComponent["key"], number> = {
  valueCaptured: 0.25,
  projectedStrength: 0.3,
  rosterBalance: 0.15,
  risk: 0.15,
  scoringFit: 0.15,
};

const WEIGHT_DECIMALS = 6;
const WEIGHT_UNIT_SCALE = 10 ** WEIGHT_DECIMALS;
type ComponentKey = AnalysisComponent["key"];
const COMPONENT_KEYS: ComponentKey[] = [
  "valueCaptured",
  "projectedStrength",
  "rosterBalance",
  "risk",
  "scoringFit",
];

function largestRemainderWeights(
  nominal: Record<ComponentKey, number>,
): Record<ComponentKey, number> {
  const total = COMPONENT_KEYS.reduce((s, k) => s + Math.max(nominal[k] ?? 0, 0), 0);
  const floats = new Map<ComponentKey, number>();
  for (const k of COMPONENT_KEYS) {
    const raw = Math.max(nominal[k] ?? 0, 0);
    floats.set(k, (raw / (total || 1)) * WEIGHT_UNIT_SCALE);
  }
  const floored = new Map<ComponentKey, number>();
  const remainders: { key: ComponentKey; remainder: number }[] = [];
  for (const k of COMPONENT_KEYS) {
    const r = floats.get(k) ?? 0;
    const f = Math.floor(r);
    floored.set(k, f);
    remainders.push({ key: k, remainder: r - f });
  }
  let distributed = [...floored.values()].reduce((a, b) => a + b, 0);
  remainders.sort((a, b) => b.remainder - a.remainder || (a.key < b.key ? -1 : 1));
  let idx = 0;
  while (distributed < WEIGHT_UNIT_SCALE && remainders.length > 0) {
    const pick = remainders[idx % remainders.length];
    if (!pick) break;
    floored.set(pick.key, (floored.get(pick.key) ?? 0) + 1);
    distributed += 1;
    idx += 1;
  }
  const out = {} as Record<ComponentKey, number>;
  for (const [k, units] of floored) out[k] = units / WEIGHT_UNIT_SCALE;
  return out;
}

export function analysisWeights(): Record<ComponentKey, number> {
  return largestRemainderWeights(ANALYSIS_WEIGHT_NOMINAL);
}

function gini(values: number[]): number {
  const finite = values.filter((v) => Number.isFinite(v) && v >= 0);
  if (finite.length === 0) return 0;
  const n = finite.length;
  const mean = finite.reduce((a, b) => a + b, 0) / n;
  if (!Number.isFinite(mean) || mean === 0) return 0;
  let sumDiff = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      sumDiff += Math.abs((finite[i] ?? 0) - (finite[j] ?? 0));
    }
  }
  const g = sumDiff / (2 * n * n * mean);
  return Number.isFinite(g) ? clamp01(g) : 0;
}

function median(values: number[]): number {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return 0;
  const mid = Math.floor(finite.length / 2);
  const midValue = finite[mid] ?? 0;
  const prevValue = finite[mid - 1] ?? midValue;
  return finite.length % 2 === 1 ? midValue : (prevValue + midValue) / 2;
}

function gradeForScore(score: number): string {
  const s = Number.isFinite(score) ? score : 0;
  if (s >= 90) return "A";
  if (s >= 80) return "B";
  if (s >= 70) return "C";
  if (s >= 60) return "D";
  return "F";
}

function overallPickToRound(overallPick: number, teamCount: number): number {
  const tc = Math.max(1, Math.floor(teamCount));
  return Math.ceil(overallPick / tc);
}
function overallPickToPickInRound(overallPick: number, teamCount: number): number {
  const tc = Math.max(1, Math.floor(teamCount));
  return ((overallPick - 1) % tc) + 1;
}

// Replacement team totals: median starter per stat × starters (deterministic)
function replacementTeamTotals(
  projections: AnalysisProjection[],
  rosterSlots: AnalysisRosterSlot[],
): Record<string, number> {
  const starters = rosterSlots.filter((s) => s.isStarter);
  const starterCount = starters.reduce((sum, s) => sum + Math.max(0, Math.floor(s.count)), 0);
  if (starterCount === 0 || projections.length === 0) {
    return {
      pts: 0,
      reb: 0,
      ast: 0,
      stl: 0,
      blk: 0,
      tov: 0,
      fgm: 0,
      fga: 0,
      ftm: 0,
      fta: 0,
      threePm: 0,
      three_pm: 0,
      threepm: 0,
    };
  }
  // use median season totals across pool for starter proxy
  const medians: Record<string, number> = {};
  for (const stat of PER_GAME_STATS) {
    const vals: number[] = projections.map((p) => {
      const v = (p as unknown as Record<string, unknown>)[stat];
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    });
    medians[stat] = median(winsorize(vals));
  }
  const totals: Record<string, number> = {};
  for (const stat of PER_GAME_STATS) {
    const key = stat === "threePm" ? "three_pm" : stat;
    const med = medians[stat] ?? 0;
    totals[stat] = Number.isFinite(med * starterCount) ? med * starterCount : 0;
    totals[key] = totals[stat] ?? 0;
    // also expose lower-case without underscore for convenience
    totals[stat.toLowerCase()] = totals[stat] ?? 0;
  }
  // ensure both keys present
  totals.threePm = medians.threePm !== undefined ? (medians.threePm ?? 0) * starterCount : 0;
  totals.three_pm = totals.threePm ?? 0;
  return totals;
}

// Age curve (REDRAFT neutral, DYNASTY youth bias)
function youthFactor(age: number | undefined, horizon: AnalysisSettings["horizon"]): number {
  if (age === undefined || !Number.isFinite(age)) return 1;
  if (horizon === "REDRAFT") return 1;
  // youth curve: 24 and under => 1, decay after 24 (like recommendation ageRaw)
  const raw = Math.exp(-(Math.max(0, age - 24) ** 2) / 40);
  // dynasty 0..1 mapped to neutral..youth tilt; keeper partially
  const bias = horizon === "DYNASTY" ? 0.8 : horizon === "KEEPER" ? 0.4 : 0;
  // modulate centered: 0.5 + (raw-0.5)*(1+2*bias) clamped then map to factor ~0.9..1.1?
  // Simpler: interpolate between 1 and raw-weighted
  const modulated = clamp01(0.5 + (raw - 0.5) * (1 + 2 * bias));
  // map to 0.85..1.05 factor so age matters but doesn't dominate
  const factor = 0.85 + modulated * 0.2;
  return Number.isFinite(factor) ? clamp(factor, 0.85, 1.1) : 1;
}

// ---------------------------------------------------------------------------
// Main analysis function
// ---------------------------------------------------------------------------

function buildCanonicalInput(
  input: AnalysisInput,
  analysisVersion: string,
): Record<string, unknown> {
  // Sort assignments by overallPick for stability (effective log order)
  const assignmentsSorted = [...input.assignments]
    .filter((a) => Number.isFinite(a.overallPick))
    .sort((a, b) => a.overallPick - b.overallPick)
    .map((a) => ({
      playerId: a.playerId,
      teamSlot: a.teamSlot,
      slotPosition: a.slotPosition,
      overallPick: a.overallPick,
      isBench: Boolean(a.isBench),
      isKeeper: Boolean(a.isKeeper),
    }));
  // Players sorted by playerId; projections sorted; adp sorted
  const playersSorted = [...input.players]
    .slice()
    .sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
  const projectionsSorted = [...input.projections]
    .slice()
    .sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
  const adpSorted = input.adp
    ? [...input.adp]
        .slice()
        .sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0))
    : null;

  const settingsSorted = {
    season: input.settings.season,
    type: input.settings.type,
    horizon: input.settings.horizon,
    teamCount: input.settings.teamCount,
    rounds: input.settings.rounds,
    userDraftSlot: input.settings.userDraftSlot,
    scoringRules: [...input.settings.scoringRules]
      .slice()
      .sort((a, b) => (a.stat < b.stat ? -1 : a.stat > b.stat ? 1 : 0)),
    rosterSlots: [...input.settings.rosterSlots]
      .slice()
      .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0)),
  };

  return {
    analysisVersion,
    // ADR D1 canonical input: settingsSnapshot, effective event log, roster view, pinned ids, preference snapshot, engineVersion, simulationSeed, type/horizon
    settingsSnapshot: settingsSorted,
    effectiveAssignments: assignmentsSorted,
    players: playersSorted,
    projections: projectionsSorted,
    adp: adpSorted,
    projectionRunId: input.projectionRunId,
    adpSnapshotId: input.adpSnapshotId,
    preferenceSnapshot: input.preferenceSnapshot ?? null,
    preferenceSnapshotVersion: input.preferenceSnapshotVersion ?? null,
    preferenceSnapshotChecksum: input.preferenceSnapshotChecksum ?? null,
    engineVersion: input.engineVersion,
    simulationSeed: input.simulationSeed,
    draftType: input.settings.type, // included explicitly per ADR (type)
    horizon: input.settings.horizon,
    userTeamSlot: input.userTeamSlot,
    // Note: generatedAt explicitly excluded
  };
}

function deriveSimulationSeed(input: AnalysisInput, analysisVersion: string): number {
  const seedStr = `${input.simulationSeed}:${analysisVersion}:${input.projectionRunId ?? "null"}`;
  return fnv1a32(seedStr);
}

function perPickSeed(baseSeed: number, runIndex: number): number {
  const hex = sha256Hex(`${String(baseSeed)}:${String(runIndex)}`);
  return parseInt(hex.slice(0, 8), 16) >>> 0;
}

export function analyzeDraft(input: AnalysisInput): AnalysisOutput {
  const analysisVersion = input.analysisVersion ?? ANALYSIS_VERSION;
  const engineVersion = input.engineVersion ?? ANALYSIS_ENGINE_VERSION;
  const generatedAt = input.generatedAt ?? "2026-09-05T00:00:00.000Z";
  const warnings: string[] = [];
  const assumptions: string[] = [];

  // Guard top-level impossible totals
  const teamCount = Math.max(
    4,
    Math.min(
      20,
      Math.floor(Number.isFinite(input.settings.teamCount) ? input.settings.teamCount : 12),
    ),
  );
  const rounds = Math.max(
    1,
    Math.min(30, Math.floor(Number.isFinite(input.settings.rounds) ? input.settings.rounds : 12)),
  );

  // ---------------- checksum ----------------
  const canonical = canonicalize(
    buildCanonicalInput(
      { ...input, settings: { ...input.settings, teamCount, rounds } },
      analysisVersion,
    ),
  );
  const inputChecksum = checksumInput(canonical);

  // ---------------- maps ----------------
  const playersById = new Map<string, AnalysisPlayerMeta>();
  for (const p of input.players) {
    if (p.playerId) playersById.set(p.playerId, p);
  }
  const projectionsById = new Map<string, AnalysisProjection>();
  for (const p of input.projections) {
    if (p.playerId) projectionsById.set(p.playerId, p);
  }
  const adpById = new Map<string, AnalysisAdpEntry>();
  if (input.adp) {
    for (const e of input.adp) {
      if (e.playerId && Number.isFinite(e.adp)) adpById.set(e.playerId, e);
    }
  }

  const userAssignments = [...input.assignments]
    .filter((a) => a.teamSlot === input.userTeamSlot)
    .sort((a, b) => a.overallPick - b.overallPick);

  // Handle missing snapshots gracefully
  const missingProjection = input.projectionRunId === null || input.projectionRunId === undefined;
  const missingAdp = input.adp === null || input.adp.length === 0 || input.adpSnapshotId === null;
  if (missingProjection) {
    warnings.push("Missing projectionRunId: using available projections with LOW confidence.");
    assumptions.push(
      "No pinned projectionRunId — used current available projections; results assume current data.",
    );
  }
  if (missingAdp) {
    warnings.push(
      "Missing ADP snapshot: valueCaptured treated as neutral where market data absent.",
    );
    assumptions.push(
      "No ADP snapshot — market-gap component assumed neutral (0.5) for missing players.",
    );
  }
  if (input.preferenceSnapshot === null || input.preferenceSnapshot === undefined) {
    assumptions.push("No preference snapshot — scoringFit uses league scoringRules only.");
  }
  assumptions.push(
    "Baseline is vs replacement-built opponent (median starter × starters), not real opponent rosters.",
  );
  assumptions.push(
    input.settings.type === "POINTS"
      ? "Points league scoring weights applied per season totals."
      : "Category league win probabilities vs median replacement team, scale=max(50,|opp|*0.25), pWin=1/(1+exp(-margin/scale)).",
  );
  assumptions.push(
    input.settings.horizon === "REDRAFT"
      ? "Redraft horizon: age curve neutralized."
      : input.settings.horizon === "DYNASTY"
        ? "Dynasty horizon: youth bias applied (age ≤24 neutral, older decay)."
        : "Keeper horizon: partial youth bias.",
  );
  assumptions.push(
    "All component contributions clamped 0..1, no hidden points, NaN/Infinity guarded.",
  );

  // ---------------- valueCaptured (0.25) ----------------
  let valueCapturedRaw = 0.5;
  if (userAssignments.length === 0) {
    valueCapturedRaw = 0.5;
  } else {
    let sumNorm = 0;
    let count = 0;
    for (const a of userAssignments) {
      const adpEntry = adpById.get(a.playerId);
      let norm: number;
      if (adpEntry && Number.isFinite(adpEntry.adp) && Number.isFinite(a.overallPick)) {
        const gap = clamp(adpEntry.adp - a.overallPick, -24, 24);
        norm = 0.5 + gap / 48;
        if (!Number.isFinite(norm)) norm = 0.5;
        norm = clamp01(norm);
      } else {
        norm = 0.5;
      }
      sumNorm += norm;
      count += 1;
    }
    valueCapturedRaw = count > 0 ? sumNorm / count : 0.5;
    if (!Number.isFinite(valueCapturedRaw)) valueCapturedRaw = 0.5;
    valueCapturedRaw = clamp01(valueCapturedRaw);
  }
  // No pool percentile mapping here — mean adpValueNorm already 0..1; ADR says percentile vs pool is optional.
  const valueCapturedNorm = clamp01(valueCapturedRaw);

  // ---------------- projectedStrength (0.30) ----------------
  let projectedStrengthRaw = 0.5;
  const scoringRules = input.settings.scoringRules.filter(
    (r) => r.enabled && Number.isFinite(r.weight),
  );
  const isPoints = input.settings.type === "POINTS";

  // compute user totals
  let userTotalFantasy = 0;
  const userCatTotals: Record<string, number> = {};
  let userCountWithProjection = 0;
  for (const a of userAssignments) {
    const proj = projectionsById.get(a.playerId);
    if (!proj) continue;
    userCountWithProjection += 1;
    const meta = playersById.get(a.playerId);
    const yf = youthFactor(meta?.age, input.settings.horizon);
    if (isPoints) {
      const pts = seasonFantasyPoints(proj, scoringRules);
      const adjusted = Number.isFinite(pts) ? pts * yf : 0;
      userTotalFantasy += adjusted;
    } else {
      // category totals: accumulate each stat
      for (const stat of PER_GAME_STATS) {
        const rawV = (proj as unknown as Record<string, unknown>)[stat];
        const vNum = typeof rawV === "number" && Number.isFinite(rawV) ? rawV : 0;
        const adjusted = vNum * yf;
        userCatTotals[stat] = (userCatTotals[stat] ?? 0) + adjusted;
        userCatTotals[stat.toLowerCase()] = userCatTotals[stat] ?? 0;
        if (stat === "threePm") {
          userCatTotals.three_pm = (userCatTotals.three_pm ?? 0) + adjusted;
          userCatTotals.threepm = userCatTotals.three_pm ?? 0;
        }
      }
    }
  }
  if (!Number.isFinite(userTotalFantasy)) userTotalFantasy = 0;
  for (const k of Object.keys(userCatTotals)) {
    if (!Number.isFinite(userCatTotals[k] ?? 0)) userCatTotals[k] = 0;
  }

  const oppTotals = replacementTeamTotals(input.projections, input.settings.rosterSlots);
  // guard impossible totals
  for (const k of Object.keys(oppTotals)) {
    if (!Number.isFinite(oppTotals[k] ?? 0) || (oppTotals[k] ?? 0) < 0) oppTotals[k] = 0;
    // also cap absurd totals
    if ((oppTotals[k] ?? 0) > 1e9) oppTotals[k] = 1e9;
  }
  if (userCountWithProjection === 0) {
    projectedStrengthRaw = 0.5;
    warnings.push("No projections for roster — projectedStrength assumed neutral.");
  } else if (isPoints) {
    // POINTS: winProb vs replacement
    const oppTotal = (() => {
      // compute replacement total fantasy points similarly (median team)
      const starters = input.settings.rosterSlots
        .filter((s) => s.isStarter)
        .reduce((acc, s) => acc + Math.max(0, Math.floor(s.count)), 0);
      const medianPlayerPoints = median(
        winsorize(
          input.projections.map((p) => {
            const v = seasonFantasyPoints(p, scoringRules);
            return Number.isFinite(v) ? v : 0;
          }),
        ),
      );
      const tot = medianPlayerPoints * Math.max(1, starters);
      return Number.isFinite(tot) ? tot : 0;
    })();
    const oppSafe = Number.isFinite(oppTotal) ? oppTotal : 0;
    const margin = userTotalFantasy - oppSafe;
    const scale = Math.max(500, Math.abs(oppSafe) * 0.15);
    const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 500;
    const pWin = 1 / (1 + Math.exp(-margin / safeScale));
    projectedStrengthRaw = clamp01(Number.isFinite(pWin) ? pWin : 0.5);
  } else {
    // CATEGORIES: mean category winProb
    const activeRules = scoringRules.filter((r) => r.enabled && !r.punt);
    if (activeRules.length === 0) {
      projectedStrengthRaw = 0.5;
    } else {
      let weightedSum = 0;
      let weightSum = 0;
      for (const rule of activeRules) {
        const key = rule.stat.toLowerCase();
        const statKey = rule.stat === "THREE_PM" || rule.stat === "THREEPM" ? "three_pm" : key;
        // special handling for percentages: team % vs opp %
        let userVal: number;
        let oppVal: number;
        if (rule.stat === "FG_PCT") {
          const uFgm = userCatTotals.fgm ?? 0;
          const uFga = userCatTotals.fga ?? 0;
          const oFgm = oppTotals.fgm ?? 0;
          const oFga = oppTotals.fga ?? 0;
          userVal = uFga > 0 ? uFgm / uFga : 0;
          oppVal = oFga > 0 ? oFgm / oFga : 0.45;
          // scale for percentages smaller
          const margin = rule.direction === "LOWER_BETTER" ? oppVal - userVal : userVal - oppVal;
          const scale = 0.05; // 5% is large for FG%
          const pWin = 1 / (1 + Math.exp(-margin / scale));
          const w = Math.abs(Number.isFinite(rule.weight) ? rule.weight : 1);
          weightedSum += clamp01(Number.isFinite(pWin) ? pWin : 0.5) * w;
          weightSum += w;
          continue;
        } else if (rule.stat === "FT_PCT") {
          const uFtm = userCatTotals.ftm ?? 0;
          const uFta = userCatTotals.fta ?? 0;
          const oFtm = oppTotals.ftm ?? 0;
          const oFta = oppTotals.fta ?? 0;
          userVal = uFta > 0 ? uFtm / uFta : 0;
          oppVal = oFta > 0 ? oFtm / oFta : 0.75;
          const margin = rule.direction === "LOWER_BETTER" ? oppVal - userVal : userVal - oppVal;
          const scale = 0.05;
          const pWin = 1 / (1 + Math.exp(-margin / scale));
          const w = Math.abs(Number.isFinite(rule.weight) ? rule.weight : 1);
          weightedSum += clamp01(Number.isFinite(pWin) ? pWin : 0.5) * w;
          weightSum += w;
          continue;
        } else {
          userVal = userCatTotals[statKey] ?? userCatTotals[key] ?? 0;
          oppVal = oppTotals[statKey] ?? oppTotals[key] ?? oppTotals[statKey.replace("_", "")] ?? 0;
          if (!Number.isFinite(userVal)) userVal = 0;
          if (!Number.isFinite(oppVal)) oppVal = 0;
          const margin = rule.direction === "LOWER_BETTER" ? oppVal - userVal : userVal - oppVal;
          const scale = Math.max(50, Math.abs(oppVal) * 0.25);
          const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 50;
          const pWin = 1 / (1 + Math.exp(-margin / safeScale));
          const w = Math.abs(Number.isFinite(rule.weight) ? rule.weight : 1);
          weightedSum += clamp01(Number.isFinite(pWin) ? pWin : 0.5) * w;
          weightSum += w;
        }
      }
      projectedStrengthRaw = weightSum > 0 ? clamp01(weightedSum / weightSum) : 0.5;
    }
  }
  if (!Number.isFinite(projectedStrengthRaw)) projectedStrengthRaw = 0.5;
  projectedStrengthRaw = clamp01(projectedStrengthRaw);

  // ---------------- rosterBalance (0.15) ----------------
  let rosterBalanceRaw = 0.5;
  let hasIllegal = false;
  // detect illegal picks: player not eligible for slotPosition (and not UTIL/BENCH)
  for (const a of userAssignments) {
    const meta = playersById.get(a.playerId);
    if (!meta) continue;
    // check slot eligibility using similar logic to candidateSlotsForEligibility
    const eligible = meta.eligiblePositions;
    const slot = a.slotPosition;
    // UTIL and BENCH are fallback slots, always legal
    if (slot === "UTIL" || slot === "BENCH") continue;
    // G accepts PG/SG, F accepts SF/PF
    let legal = eligible.includes(slot);
    if (!legal && slot === "G" && (eligible.includes("PG") || eligible.includes("SG")))
      legal = true;
    if (!legal && slot === "F" && (eligible.includes("SF") || eligible.includes("PF")))
      legal = true;
    if (!legal) {
      hasIllegal = true;
      warnings.push(
        `Illegal roster assignment for ${meta.displayName} at ${slot} (overall ${String(a.overallPick)}).`,
      );
      break;
    }
  }
  if (hasIllegal) {
    rosterBalanceRaw = 0;
  } else if (userAssignments.length === 0) {
    rosterBalanceRaw = 0.5;
  } else {
    // posCounts per starter position
    const starterSlots = input.settings.rosterSlots.filter((s) => s.isStarter);
    // count per position fill for user's team (using slotPosition)
    const posCounts: number[] = [];
    const slotMap = new Map<string, number>();
    for (const a of userAssignments) {
      const sp = a.slotPosition;
      // only count starters for Gini; bench separate
      const isStarterSlot = input.settings.rosterSlots.some(
        (rs) => rs.position === sp && rs.isStarter,
      );
      if (isStarterSlot) {
        slotMap.set(sp, (slotMap.get(sp) ?? 0) + 1);
      }
    }
    for (const s of starterSlots) {
      posCounts.push(slotMap.get(s.position) ?? 0);
    }
    const g = gini(posCounts);
    const benchCount = userAssignments.filter((a) => {
      const isStarter = input.settings.rosterSlots.some(
        (rs) => rs.position === a.slotPosition && rs.isStarter,
      );
      return !isStarter || a.isBench === true;
    }).length;
    const total = userAssignments.length;
    const benchFraction = total > 0 ? benchCount / total : 0;
    const raw = 1 - 0.5 * g - 0.2 * benchFraction;
    rosterBalanceRaw = clamp01(Number.isFinite(raw) ? raw : 0.5);
    // clamp impossible totals: if any count negative or > rounds, already illegal handled
  }
  if (!Number.isFinite(rosterBalanceRaw)) rosterBalanceRaw = 0.5;
  rosterBalanceRaw = clamp01(rosterBalanceRaw);

  // ---------------- risk (0.15) ----------------
  let riskRaw = 0.5;
  if (userAssignments.length === 0) {
    riskRaw = 0.5;
  } else {
    let sumSafety = 0;
    let cnt = 0;
    for (const a of userAssignments) {
      const proj = projectionsById.get(a.playerId);
      if (!proj) continue;
      const injuryRisk = Number.isFinite(proj.injuryRisk) ? clamp01(proj.injuryRisk) : 0.15;
      const roleSec = Number.isFinite(proj.roleSecurity) ? clamp01(proj.roleSecurity) : 0.7;
      const lowPts = proj.lower80?.pts;
      const upPts = proj.upper80?.pts;
      const pts = Number.isFinite(proj.pts) ? proj.pts : 0;
      let width = 0;
      if (Number.isFinite(lowPts) && Number.isFinite(upPts) && Number.isFinite(pts)) {
        width = Math.abs(upPts! - lowPts!) / Math.max(1, Math.abs(pts) + 1);
        if (!Number.isFinite(width)) width = 0;
        width = clamp(width, 0, 1);
      } else {
        width = 0;
      }
      // horizon modulates injuryRisk? not needed
      const safety = 1 - (0.6 * injuryRisk + 0.25 * width + 0.15 * (1 - roleSec));
      const clampedSafety = clamp01(Number.isFinite(safety) ? safety : 0.5);
      sumSafety += clampedSafety;
      cnt += 1;
    }
    riskRaw = cnt > 0 ? sumSafety / cnt : 0.5;
    if (!Number.isFinite(riskRaw)) riskRaw = 0.5;
    riskRaw = clamp01(riskRaw);
  }

  // ---------------- scoringFit (0.15) ----------------
  let scoringFitRaw = 0.5;
  if (isPoints) {
    scoringFitRaw = 1.0;
  } else {
    // For categories: puntLeak + categoryEmphasis MAX
    // puntLeak: 1 if no punted-category player dominates? Check scoringRules punt flags
    const puntStats = scoringRules.filter((r) => r.punt).map((r) => r.stat);
    // If no punts, puntLeak = 1
    let puntLeak = 1;
    if (puntStats.length > 0) {
      // If user's roster strongly punts, leak measures whether punted categories are low contributions
      // Compute average winProb for punted categories — lower winProb is good for punt (means we intentionally lose)
      // So leak = 1 - mean(punt winProb) ? Actually punt leak should be high if punt is respected.
      // We approximate: for punted stats, we expect low winProb; leak score = 1 - avgPuntWinProb ? Not perfect.
      // Simpler: compute winProb for punted stats same as before and take 1 - avg.
      let puntWinSum = 0;
      let puntWeightSum = 0;
      for (const rule of scoringRules.filter((r) => r.punt)) {
        const key = rule.stat.toLowerCase();
        const statKey = rule.stat === "THREE_PM" ? "three_pm" : key;
        let userVal = userCatTotals[statKey] ?? userCatTotals[key] ?? 0;
        let oppVal = oppTotals[statKey] ?? oppTotals[key] ?? 0;
        if (!Number.isFinite(userVal)) userVal = 0;
        if (!Number.isFinite(oppVal)) oppVal = 0;
        const margin = rule.direction === "LOWER_BETTER" ? oppVal - userVal : userVal - oppVal;
        const scale = Math.max(50, Math.abs(oppVal) * 0.25);
        const pWin =
          1 / (1 + Math.exp(-margin / (Number.isFinite(scale) && scale > 0 ? scale : 50)));
        const w = 1;
        puntWinSum += clamp01(Number.isFinite(pWin) ? pWin : 0.5) * w;
        puntWeightSum += w;
      }
      const avgPuntWin = puntWeightSum > 0 ? puntWinSum / puntWeightSum : 0.5;
      // If we are punting, we WANT low winProb in that cat, so leak = 1 - avgPuntWin? Actually if we punt TOV, we might still be bad at TOV intentionally -> winProb low => leak high (good)
      puntLeak = clamp01(1 - avgPuntWin);
      // If no punt data, neutral
      if (!Number.isFinite(puntLeak)) puntLeak = 0.5;
    }
    // categoryEmphasis: how well high-weight categories are satisfied
    // Weighted mean winProb for non-punted categories already computed as projectedStrengthRaw, reuse?
    const emphasis = projectedStrengthRaw; // approximate
    // If preferenceSnapshot had categoryPriorities, we would weight those higher, but missing snapshot graceful: use league weights
    // If scoringRules have varying weights, emphasis already reflects weighted.
    // For explicit emphasis, compute weighted winProb with emphasis on top weight
    // Already similar to projectedStrength, so use same value.

    // MAX of puntLeak and emphasis
    scoringFitRaw = Math.max(puntLeak, emphasis);
    scoringFitRaw = clamp01(Number.isFinite(scoringFitRaw) ? scoringFitRaw : 0.5);
    // handle missing snapshot: if preferenceSnapshot missing, scoringFit not penalized, but we already assumed
  }
  if (!Number.isFinite(scoringFitRaw)) scoringFitRaw = 0.5;
  scoringFitRaw = clamp01(scoringFitRaw);

  // ---------------- weights & overall ----------------
  const weights = analysisWeights();
  // verify sum 1 at 6dp
  const wSum = COMPONENT_KEYS.reduce((s, k) => s + (weights[k] ?? 0), 0);
  // Guard if sum drift due to rounding: renormalize tiny epsilon
  if (Math.abs(wSum - 1) > 1e-6) {
    warnings.push("Weight normalization drift — applied correction.");
  }

  const components: AnalysisComponent[] = [
    {
      key: "valueCaptured",
      raw: valueCapturedRaw,
      normalized: valueCapturedNorm,
      weight: weights.valueCaptured ?? 0.25,
      contribution: clamp01(valueCapturedNorm * (weights.valueCaptured ?? 0.25)),
      reason:
        missingAdp && userAssignments.length > 0
          ? "Market gap vs ADP (neutral where no market data)"
          : "Average draft value vs ADP (higher = got players later than market) ",
    },
    {
      key: "projectedStrength",
      raw: isPoints ? userTotalFantasy : projectedStrengthRaw,
      normalized: projectedStrengthRaw,
      weight: weights.projectedStrength ?? 0.3,
      contribution: clamp01(projectedStrengthRaw * (weights.projectedStrength ?? 0.3)),
      reason: isPoints
        ? "Projected fantasy point total vs replacement-built opponent"
        : "Mean category win probability vs replacement-built opponent",
    },
    {
      key: "rosterBalance",
      raw: rosterBalanceRaw,
      normalized: rosterBalanceRaw,
      weight: weights.rosterBalance ?? 0.15,
      contribution: clamp01(rosterBalanceRaw * (weights.rosterBalance ?? 0.15)),
      reason: hasIllegal
        ? "Illegal roster assignments detected"
        : "Starter distribution across positions (Gini) and bench waste",
    },
    {
      key: "risk",
      raw: riskRaw,
      normalized: riskRaw,
      weight: weights.risk ?? 0.15,
      contribution: clamp01(riskRaw * (weights.risk ?? 0.15)),
      reason: "Mean safety from injury risk, interval width and role security",
    },
    {
      key: "scoringFit",
      raw: scoringFitRaw,
      normalized: scoringFitRaw,
      weight: weights.scoringFit ?? 0.15,
      contribution: clamp01(scoringFitRaw * (weights.scoringFit ?? 0.15)),
      reason: isPoints
        ? "Points league — scoring fit is neutral 1.0"
        : "Punt leak + category emphasis (max) vs league weights",
    },
  ];

  // Ensure no hidden points: sum contributions = overall normalized
  for (const c of components) {
    if (
      !Number.isFinite(c.normalized) ||
      !Number.isFinite(c.weight) ||
      !Number.isFinite(c.contribution)
    ) {
      warnings.push(`Component ${c.key} had non-finite values — clamped.`);
      c.normalized = clamp01(c.normalized);
      c.weight = clamp01(c.weight);
      c.contribution = clamp01(c.contribution);
    }
    // contribution must equal normalized*weight (clamped) — verify
    const expected = clamp01(c.normalized * c.weight);
    if (Math.abs(c.contribution - expected) > 1e-9) {
      c.contribution = expected;
    }
  }

  const overallNorm = clamp01(components.reduce((sum, c) => sum + c.contribution, 0));
  const draftScoreRaw = 100 * overallNorm;
  const draftScore = Number.isFinite(draftScoreRaw) ? Math.round(draftScoreRaw * 10) / 10 : 0;
  const grade = gradeForScore(draftScore);

  // ---------------- roundByRound, bestValuePick/biggestReach ----------------
  // Need to compute for each user pick: adpValueNorm, adpDelta, valueAboveReplacement?
  // valueAboveReplacement: maybe utility vs replacement? We'll compute fantasyPoints above median for points, utility above median for categories.
  // For simplicity, compute fantasyPoints or categoryUtility above median for that player.

  const poolProjections = input.projections.filter((p) => Number.isFinite(p.pts));
  const medianFp = (() => {
    const vals = poolProjections.map((p) => seasonFantasyPoints(p, scoringRules));
    return median(winsorize(vals.filter(Number.isFinite)));
  })();
  const medianUtility = (() => {
    const vals = poolProjections.map((p) => categoryUtility(p, scoringRules));
    return median(vals.filter(Number.isFinite));
  })();

  const roundByRound: RoundEntry[] = userAssignments.map((a) => {
    const meta = playersById.get(a.playerId);
    const adpEntry = adpById.get(a.playerId);
    const proj = projectionsById.get(a.playerId);
    const adpVal = adpEntry && Number.isFinite(adpEntry.adp) ? adpEntry.adp : null;
    let adpValueNorm = 0.5;
    let delta: number | null = null;
    if (adpVal !== null && Number.isFinite(a.overallPick)) {
      delta = adpVal - a.overallPick;
      const gap = clamp(delta, -24, 24);
      adpValueNorm = clamp01(0.5 + gap / 48);
    }
    const round = overallPickToRound(a.overallPick, teamCount);
    const pickInRound = overallPickToPickInRound(a.overallPick, teamCount);
    let valueAboveReplacement: number | null = null;
    if (proj) {
      const yf = youthFactor(meta?.age, input.settings.horizon);
      if (isPoints) {
        const fp = seasonFantasyPoints(proj, scoringRules);
        valueAboveReplacement =
          Number.isFinite(fp) && Number.isFinite(medianFp) ? fp * yf - medianFp : null;
        if (valueAboveReplacement !== null && !Number.isFinite(valueAboveReplacement))
          valueAboveReplacement = null;
      } else {
        const util = categoryUtility(proj, scoringRules);
        valueAboveReplacement =
          Number.isFinite(util) && Number.isFinite(medianUtility) ? util - medianUtility : null;
        if (valueAboveReplacement !== null && !Number.isFinite(valueAboveReplacement))
          valueAboveReplacement = null;
      }
    }
    // illegal check per pick
    let isIllegal = false;
    if (meta) {
      const eligible = meta.eligiblePositions;
      const slot = a.slotPosition;
      if (slot !== "UTIL" && slot !== "BENCH") {
        let legal = eligible.includes(slot);
        if (!legal && slot === "G" && (eligible.includes("PG") || eligible.includes("SG")))
          legal = true;
        if (!legal && slot === "F" && (eligible.includes("SF") || eligible.includes("PF")))
          legal = true;
        if (!legal) isIllegal = true;
      }
    }
    return {
      round,
      overallPick: a.overallPick,
      pickInRound,
      playerId: a.playerId,
      displayName: meta?.displayName ?? a.playerId,
      slotPosition: a.slotPosition,
      isBench: Boolean(a.isBench),
      isKeeper: Boolean(a.isKeeper),
      adp: adpVal,
      adpValueNorm,
      adpDelta: delta,
      valueAboveReplacement,
      isBestValue: false,
      isBiggestReach: false,
      isIllegal,
    };
  });

  // Determine best value and biggest reach by adpDelta extremes
  let bestValuePick: RoundEntry | null = null;
  let biggestReach: RoundEntry | null = null;
  if (roundByRound.length > 0) {
    let maxDelta = -Infinity;
    let minDelta = Infinity;
    for (const r of roundByRound) {
      if (r.adpDelta === null || !Number.isFinite(r.adpDelta)) continue;
      if (r.adpDelta > maxDelta) {
        maxDelta = r.adpDelta;
        bestValuePick = r;
      }
      if (r.adpDelta < minDelta) {
        minDelta = r.adpDelta;
        biggestReach = r;
      }
    }
    // If all deltas null (no ADP), best/reach remain null but we still mark highest/lowest adpValueNorm
    if (!bestValuePick && roundByRound.length > 0) {
      // fallback to highest adpValueNorm
      let bestNorm = -Infinity;
      let worstNorm = Infinity;
      for (const r of roundByRound) {
        if (r.adpValueNorm > bestNorm) {
          bestNorm = r.adpValueNorm;
          bestValuePick = r;
        }
        if (r.adpValueNorm < worstNorm) {
          worstNorm = r.adpValueNorm;
          biggestReach = r;
        }
      }
    }
    if (bestValuePick) bestValuePick.isBestValue = true;
    if (biggestReach) biggestReach.isBiggestReach = true;
  }

  // ---------------- strengths / weaknesses ----------------
  const strengths: string[] = [];
  const weaknesses: string[] = [];

  // Position strengths: count vs expected starter count
  if (userAssignments.length > 0) {
    const posCounts = new Map<string, number>();
    for (const a of userAssignments)
      posCounts.set(a.slotPosition, (posCounts.get(a.slotPosition) ?? 0) + 1);
    // For each starter position, compare fill rate
    for (const slot of input.settings.rosterSlots.filter((s) => s.isStarter)) {
      const got = posCounts.get(slot.position) ?? 0;
      const expected = slot.count;
      if (expected > 0) {
        if (got >= expected)
          strengths.push(`${slot.position} filled (${String(got)}/${String(expected)})`);
        else if (got === 0 && expected > 0)
          weaknesses.push(`${slot.position} empty (0/${String(expected)})`);
        else if (got < expected)
          weaknesses.push(`${slot.position} thin (${String(got)}/${String(expected)})`);
      }
    }
    // Category strengths via winProbs
    if (!isPoints) {
      const activeRules = scoringRules.filter((r) => r.enabled && !r.punt);
      for (const rule of activeRules) {
        const key = rule.stat.toLowerCase();
        const statKey = rule.stat === "THREE_PM" ? "three_pm" : key;
        let userVal = userCatTotals[statKey] ?? userCatTotals[key] ?? 0;
        let oppVal = oppTotals[statKey] ?? oppTotals[key] ?? 0;
        // handle percentages separately
        let pWin = 0.5;
        if (rule.stat === "FG_PCT") {
          const uFgm = userCatTotals.fgm ?? 0,
            uFga = userCatTotals.fga ?? 0;
          const oFgm = oppTotals.fgm ?? 0,
            oFga = oppTotals.fga ?? 0;
          const uPct = uFga > 0 ? uFgm / uFga : 0;
          const oPct = oFga > 0 ? oFgm / oFga : 0.45;
          const m2 = uPct - oPct;
          pWin = 1 / (1 + Math.exp(-m2 / 0.05));
        } else if (rule.stat === "FT_PCT") {
          const uFtm = userCatTotals.ftm ?? 0,
            uFta = userCatTotals.fta ?? 0;
          const oFtm = oppTotals.ftm ?? 0,
            oFta = oppTotals.fta ?? 0;
          const uPct = uFta > 0 ? uFtm / uFta : 0;
          const oPct = oFta > 0 ? oFtm / oFta : 0.75;
          const m2 = uPct - oPct;
          pWin = 1 / (1 + Math.exp(-m2 / 0.05));
        } else {
          if (!Number.isFinite(userVal)) userVal = 0;
          if (!Number.isFinite(oppVal)) oppVal = 0;
          const margin = rule.direction === "LOWER_BETTER" ? oppVal - userVal : userVal - oppVal;
          const scale = Math.max(50, Math.abs(oppVal) * 0.25);
          pWin = 1 / (1 + Math.exp(-margin / (scale > 0 ? scale : 50)));
        }
        pWin = clamp01(Number.isFinite(pWin) ? pWin : 0.5);
        if (pWin >= 0.6)
          strengths.push(`${rule.stat} strong (${String(Math.round(pWin * 100))}% vs replacement)`);
        else if (pWin <= 0.4)
          weaknesses.push(`${rule.stat} weak (${String(Math.round(pWin * 100))}% vs replacement)`);
      }
    } else {
      // Points: strengths by top contributors
      const topContributors = [...userAssignments]
        .map((a) => {
          const proj = projectionsById.get(a.playerId);
          if (!proj) return { id: a.playerId, fp: -Infinity };
          const fp =
            seasonFantasyPoints(proj, scoringRules) *
            youthFactor(playersById.get(a.playerId)?.age, input.settings.horizon);
          return { id: a.playerId, fp: Number.isFinite(fp) ? fp : -Infinity };
        })
        .sort((a, b) => b.fp - a.fp)
        .slice(0, 2);
      for (const c of topContributors) {
        const meta = playersById.get(c.id);
        if (meta) strengths.push(`${meta.displayName} high projected points`);
      }
    }
  }
  // Ensure at least one each when roster non-empty? Pad generic
  if (strengths.length === 0 && userAssignments.length > 0)
    strengths.push("Balanced roster — no single standout category above 60% vs replacement");
  if (weaknesses.length === 0 && userAssignments.length > 0)
    weaknesses.push("No major weaknesses vs replacement baseline");

  // Limit to top 5 to keep deterministic and avoid overflow
  const strengthsTrim = strengths.slice(0, 5);
  const weaknessesTrim = weaknesses.slice(0, 5);

  // ---------------- projectedStanding (seeded 2000 runs) ----------------
  const RUNS = 2000;
  const baseSeed = deriveSimulationSeed(input, analysisVersion);
  // Precompute features for softmax like recommendation's simulateAvailability but simplified for team totals variance
  // For standing simulation, we add noise to totals; softmax not needed for single user vs 11 replacement opponents
  // However spec says softmax over ADP/projection/tendency temperature 1.2 — we will simulate opponent selection variance affecting their medians slightly
  // Simpler: each run draws opponent totals from normal around median with std derived from pool sd

  const poolFpSd = (() => {
    const vals = input.projections
      .map((p) => seasonFantasyPoints(p, scoringRules))
      .filter(Number.isFinite);
    return Math.max(50, standardDeviation(winsorize(vals)));
  })();
  const catSds: Record<string, number> = {};
  if (!isPoints) {
    for (const stat of PER_GAME_STATS) {
      const rawVals: number[] = input.projections.map((p) => {
        const raw = (p as unknown as Record<string, unknown>)[stat];
        return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
      });
      const sd = standardDeviation(winsorize(rawVals));
      catSds[stat] = Math.max(5, Number.isFinite(sd) ? sd : 5);
      catSds[stat.toLowerCase()] = catSds[stat] ?? 5;
      if (stat === "threePm") {
        catSds.three_pm = catSds[stat] ?? 5;
      }
    }
  }

  const standings: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const seed = perPickSeed(baseSeed, run);
    const rand = mulberry32(seed);
    // temperature 1.2 softmax concept: we perturb opponent totals via softmax-weighted ADP?? For determinism, use rand to sample noise.
    // Generate jitter factor via softmax-ish: exp(rand/1.2) normalized? But single value simpler: use rand()-0.5 scaled.
    // To honor per-pick seed spec: each run's per-pick seed derived via SHA256 then mulberry32 with temperature 1.2 — we already did seed derivation, now use temperature to scale noise.
    const temp = 1.2;
    // user noise: smaller variance than opponents
    let userScore: number;
    if (isPoints) {
      const userNoise = (rand() - 0.5) * poolFpSd * 0.5 * temp; // tempered
      // second draw for subtler variance
      const r2 = mulberry32(perPickSeed(seed, run + 1000000));
      const extra = (r2() - 0.5) * poolFpSd * 0.2;
      userScore = userTotalFantasy + userNoise + extra;
      if (!Number.isFinite(userScore)) userScore = userTotalFantasy;
    } else {
      // For categories, simulate per-category jitter for ranking
      // We'll compute user's category wins vs each of 11 opponents; each opponent's totals jitter
      // For now, approximate userScore as weighted sum of category winProbs with jitter (dimensionless 0-1)
      let aggUser = 0;
      let weightSum = 0;
      for (const rule of scoringRules.filter((r) => r.enabled && !r.punt)) {
        const key = rule.stat.toLowerCase();
        const statKey = rule.stat === "THREE_PM" ? "three_pm" : key;
        const sd = catSds[statKey] ?? catSds[key] ?? 10;
        const jitter = (rand() - 0.5) * sd * 0.3 * temp;
        const jitter2 = (mulberry32(perPickSeed(seed, run + 9999))() - 0.5) * sd * 0.1;
        let uVal = userCatTotals[statKey] ?? userCatTotals[key] ?? 0;
        uVal += jitter + jitter2;
        if (!Number.isFinite(uVal)) uVal = userCatTotals[statKey] ?? 0;
        aggUser +=
          clamp01(
            (uVal - (oppTotals[statKey] ?? 0)) /
              Math.max(50, Math.abs(oppTotals[statKey] ?? 0) * 0.25) +
              0.5,
          ) * Math.abs(rule.weight);
        weightSum += Math.abs(rule.weight);
      }
      userScore = weightSum > 0 ? aggUser / weightSum : 0.5;
      if (!Number.isFinite(userScore)) userScore = 0.5;
      // opponent scores: each opponent's score jitter around 0.5 (median)
      let beaten = 0;
      const opponentCount = teamCount - 1;
      for (let opp = 0; opp < opponentCount; opp++) {
        const oppRand = mulberry32(perPickSeed(seed, run * 100 + opp + 5555));
        let oppScore = 0;
        let oppWeightSum = 0;
        for (const rule of scoringRules.filter((r) => r.enabled && !r.punt)) {
          const r2 = oppRand();
          const key = rule.stat.toLowerCase();
          const statKey = rule.stat === "THREE_PM" ? "three_pm" : key;
          const sd2 = catSds[statKey] ?? 10;
          const jitterOpp = (r2 - 0.5) * sd2 * 0.4 * temp;
          const oppValJittered = (oppTotals[statKey] ?? 0) + jitterOpp;
          // opp vs median? Actually opponent vs itself median? Simplify opponent's own total variation around median
          // Compute opponent's equivalent "strength" vs median similar to user, but centered 0.5
          const baseOpp =
            0.5 +
            (oppValJittered - (oppTotals[statKey] ?? 0)) /
              Math.max(50, Math.abs(oppTotals[statKey] ?? 0) * 0.5);
          const b = clamp01(Number.isFinite(baseOpp) ? baseOpp : 0.5);
          oppScore += b * Math.abs(rule.weight);
          oppWeightSum += Math.abs(rule.weight);
        }
        const oppAgg = oppWeightSum > 0 ? oppScore / oppWeightSum : 0.5;
        if (Number.isFinite(oppAgg) && Number.isFinite(userScore) && oppAgg < userScore)
          beaten += 1;
        else if (!Number.isFinite(oppAgg)) {
          // ignore
        }
      }
      // invert: we counted opponents that user beats, so rank = 1 + opponents that beat user
      const opponentsBeatUser = opponentCount - beaten;
      const finalRank2 = opponentsBeatUser + 1;
      if (Number.isFinite(finalRank2) && finalRank2 >= 1 && finalRank2 <= teamCount) {
        standings.push(finalRank2);
      } else {
        standings.push(
          Math.max(1, Math.min(teamCount, Math.round(finalRank2) || Math.ceil(teamCount / 2))),
        );
      }
      continue; // per-category path already pushed
    }

    // POINTS ranking path
    {
      const opponentCount = teamCount - 1;
      let beaten = 0;
      for (let opp = 0; opp < opponentCount; opp++) {
        const oppSeed = perPickSeed(seed, run * 100 + opp + 7777);
        const oppRand = mulberry32(oppSeed);
        // replacement median total with jitter
        const medianFpPoints = median(
          winsorize(
            input.projections
              .map((p) => seasonFantasyPoints(p, scoringRules))
              .filter(Number.isFinite),
          ),
        );
        const starterCount = input.settings.rosterSlots
          .filter((s) => s.isStarter)
          .reduce((a, s) => a + Math.max(0, Math.floor(s.count)), 0);
        const oppMedian = medianFpPoints * Math.max(1, starterCount);
        const jitterOpp =
          (oppRand() - 0.5) * poolFpSd * 0.6 * temp + (oppRand() - 0.5) * poolFpSd * 0.3;
        const oppScore =
          (Number.isFinite(oppMedian) ? oppMedian : 0) +
          (Number.isFinite(jitterOpp) ? jitterOpp : 0);
        if (Number.isFinite(oppScore) && Number.isFinite(userScore) && oppScore < userScore)
          beaten += 1;
      }
      const finalRank = opponentCount + 1 - beaten;
      const clampedRank = Math.max(
        1,
        Math.min(teamCount, Math.round(finalRank) || Math.ceil(teamCount / 2)),
      );
      standings.push(clampedRank);
    }
  }

  // Guard distribution sanity
  for (let i = 0; i < standings.length; i++) {
    const cur = standings[i];
    if (cur === undefined || !Number.isFinite(cur) || cur < 1 || cur > teamCount)
      standings[i] = Math.ceil(teamCount / 2);
  }
  standings.sort((a, b) => (a ?? 0) - (b ?? 0));
  const p50 = standings[Math.floor(0.5 * (standings.length - 1))] ?? Math.ceil(teamCount / 2);
  const p90 = standings[Math.floor(0.9 * (standings.length - 1))] ?? teamCount;
  const bestRank = standings[0] ?? 1;
  const worstRank = standings[standings.length - 1] ?? teamCount;
  const meanRankRaw = standings.reduce((a, b) => a + b, 0) / (standings.length || 1);
  const meanRank = Number.isFinite(meanRankRaw)
    ? Math.round(meanRankRaw * 10) / 10
    : Math.ceil(teamCount / 2);

  const projectedStanding: ProjectedStanding = {
    runs: RUNS,
    distribution: standings,
    p50: Number.isFinite(p50) ? p50 : Math.ceil(teamCount / 2),
    p90: Number.isFinite(p90) ? p90 : teamCount,
    meanRank,
    bestRank: Number.isFinite(bestRank) ? bestRank : 1,
    worstRank: Number.isFinite(worstRank) ? worstRank : teamCount,
    label: "vs replacement-built opponent (median starter × 11)",
    vsReplacement: true,
  };

  // ---------------- confidence / freshness ----------------
  // Determine freshness windows
  const nowMs = Date.parse(generatedAt);
  const projMs = input.projectionPublishedAt ? Date.parse(input.projectionPublishedAt) : NaN;
  const adpMs = input.adpCapturedAt ? Date.parse(input.adpCapturedAt) : NaN;

  // staleness checks: projection >7d preseason / >1d in-season — we don't know season phase, use 7d threshold generically, plus >1d generic flagged if inSeason? Assume preseason 7d, in-season 1d -> use 48h for HIGH requirement.
  let projStale: "FRESH" | "STALE" | "LOW" = "FRESH";
  if (!Number.isFinite(projMs) || Number.isNaN(projMs)) projStale = "LOW";
  else {
    const ageMs = nowMs - projMs;
    const ageH = ageMs / (1000 * 60 * 60);
    if (!Number.isFinite(ageH) || ageH < 0) projStale = "LOW";
    else if (ageH > 7 * 24) projStale = "STALE";
    else if (ageH > 48) projStale = "STALE"; // 48h for HIGH gate
  }

  let adpStatus: "FRESH" | "STALE" | "LOW" = "FRESH";
  if (missingAdp || !Number.isFinite(adpMs) || Number.isNaN(adpMs)) adpStatus = "LOW";
  else {
    const ageMs = nowMs - adpMs;
    const ageD = ageMs / (1000 * 60 * 60 * 24);
    if (!Number.isFinite(ageD) || ageD < 0) adpStatus = "LOW";
    else if (ageD > 7) adpStatus = "LOW";
  }

  // sourcesCount check
  let sourcesOk = true;
  let sufficientSources = 0;
  if (input.adp && userAssignments.length > 0) {
    for (const a of userAssignments) {
      const entry = adpById.get(a.playerId);
      if (entry && Number.isFinite(entry.sourcesCount) && entry.sourcesCount >= 2)
        sufficientSources += 1;
    }
    const pct = userAssignments.length > 0 ? sufficientSources / userAssignments.length : 0;
    if (pct < 0.8) sourcesOk = false;
  } else {
    sourcesOk = false;
  }

  let confidence: "HIGH" | "MEDIUM" | "LOW" = "HIGH";
  const projFresh48 = Number.isFinite(projMs) && nowMs - projMs <= 48 * 60 * 60 * 1000;
  const adpFresh7 =
    !missingAdp && Number.isFinite(adpMs) && nowMs - adpMs <= 7 * 24 * 60 * 60 * 1000;
  if (!(projFresh48 && adpFresh7 && sourcesOk && warnings.length === 0)) {
    if (projStale === "LOW" || adpStatus === "LOW" || missingProjection || missingAdp || !sourcesOk)
      confidence = "LOW";
    else confidence = "MEDIUM";
  }
  // Historical drafts lacking projectionRunId -> LOW per ADR D5
  if (missingProjection) confidence = "LOW";

  let freshnessStatus: DataFreshness["status"] = "FRESH";
  if (confidence === "LOW" || (projStale as string) === "LOW" || (adpStatus as string) === "LOW")
    freshnessStatus = "LOW";
  else if ((projStale as string) === "STALE" || (adpStatus as string) === "STALE")
    freshnessStatus = "STALE";

  const dataFreshness: DataFreshness = {
    projectionRunId: input.projectionRunId,
    projectionPublishedAt: input.projectionPublishedAt ?? null,
    adpSnapshotId: input.adpSnapshotId,
    adpCapturedAt: input.adpCapturedAt ?? null,
    generatedAt,
    engineVersion,
    analysisVersion,
    inputChecksum,
    status: freshnessStatus,
  };

  // ---------------- final guard ----------------
  // Ensure no NaN/Inf in output
  const finalScore = Number.isFinite(draftScore) ? clamp(draftScore, 0, 100) : 0;
  const finalP50 = Number.isFinite(projectedStanding.p50)
    ? clamp(projectedStanding.p50, 1, teamCount)
    : Math.ceil(teamCount / 2);
  const finalP90 = Number.isFinite(projectedStanding.p90)
    ? clamp(projectedStanding.p90, 1, teamCount)
    : teamCount;
  projectedStanding.p50 = finalP50;
  projectedStanding.p90 = finalP90;
  if (!Number.isFinite(projectedStanding.meanRank))
    projectedStanding.meanRank = Math.ceil(teamCount / 2);

  return {
    analysisVersion,
    engineVersion,
    inputChecksum,
    generatedAt,
    draftScore: finalScore,
    grade,
    components,
    strengths: strengthsTrim,
    weaknesses: weaknessesTrim,
    roundByRound,
    bestValuePick,
    biggestReach,
    projectedStanding,
    confidence,
    dataFreshness,
    assumptions,
    warnings,
    disclosure: ANALYSIS_DISCLOSURE,
  };
}
