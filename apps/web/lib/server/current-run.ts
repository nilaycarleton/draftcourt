import { prisma } from "@draftcourt/db";

/** Fixed reference date for age calculations — kept identical to
 * services/analytics/app/pipelines/baseline.py::PROJECTION_AS_OF so a
 * player's computed age matches on both sides of the stack. */
export const PROJECTION_AS_OF = new Date("2026-10-01T00:00:00.000Z");
export const CURRENT_SEASON = "2026-27";

export interface CurrentRunInfo {
  runId: string;
  modelId: string;
  modelKey: string;
  modelVersion: string;
  publishedAt: Date | null;
  dataCutoff: Date;
}

/** The one published, atomically-current run for the season — never a
 * partially-published one (BUILD_SPEC.md section 7.2's atomic publish
 * guarantee, enforced at the database level by a partial unique index;
 * see docs/adr/0005-phase1-data-model.md). Returns null if no run has
 * ever been published yet (e.g. a fresh environment before
 * `uv run python -m app.pipelines.cli publish` has run) — callers must
 * handle this as an empty/stale state, never throw a 500. */
export async function getCurrentRun(): Promise<CurrentRunInfo | null> {
  const run = await prisma.projectionRun.findFirst({
    where: { season: CURRENT_SEASON, isCurrent: true },
    include: { model: true },
  });
  if (!run) return null;
  return {
    runId: run.id,
    modelId: run.modelId,
    modelKey: run.model.modelKey,
    modelVersion: run.model.version,
    publishedAt: run.publishedAt,
    dataCutoff: run.dataCutoff,
  };
}

export interface CurrentAdpSnapshotInfo {
  snapshotId: string;
  capturedAt: Date;
  methodologyVersion: string;
}

/** Most recent ADP consensus snapshot for the season, or null if none has
 * been published yet — ADP display/filtering degrades gracefully to
 * "unavailable" rather than erroring. */
export async function getCurrentAdpSnapshot(): Promise<CurrentAdpSnapshotInfo | null> {
  const snapshot = await prisma.adpConsensusSnapshot.findFirst({
    where: { season: CURRENT_SEASON },
    orderBy: { capturedAt: "desc" },
  });
  if (!snapshot) return null;
  return {
    snapshotId: snapshot.id,
    capturedAt: snapshot.capturedAt,
    methodologyVersion: snapshot.methodologyVersion,
  };
}

export function ageAt(dob: Date | null, asOf: Date = PROJECTION_AS_OF): number | null {
  if (!dob) return null;
  const diffMs = asOf.getTime() - dob.getTime();
  return diffMs / (1000 * 60 * 60 * 24 * 365.25);
}

/** Converts an inclusive age range to a dob range for querying — a player
 * `minAge` years old was born on or before `asOf - minAge` years, and a
 * player `maxAge` years old was born on or after `asOf - maxAge` years. */
export function ageRangeToDobRange(
  minAge: number | undefined,
  maxAge: number | undefined,
  asOf: Date = PROJECTION_AS_OF,
): { gte?: Date; lte?: Date } {
  const range: { gte?: Date; lte?: Date } = {};
  if (maxAge !== undefined) {
    const gte = new Date(asOf);
    gte.setUTCFullYear(gte.getUTCFullYear() - maxAge - 1);
    range.gte = gte;
  }
  if (minAge !== undefined) {
    const lte = new Date(asOf);
    lte.setUTCFullYear(lte.getUTCFullYear() - minAge);
    range.lte = lte;
  }
  return range;
}
