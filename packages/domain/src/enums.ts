import { z } from "zod";

/**
 * Core domain enums, per BUILD_SPEC.md section 4.1.
 * These are the single source of truth for both the TypeScript app layer and,
 * via generated JSON Schema, the Python analytics service (see
 * data/schemas/ and packages/domain/src/scripts/generate-schemas.ts).
 */

export const userRoleSchema = z.enum(["USER", "ADMIN"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const leagueTypeSchema = z.enum(["POINTS", "CATEGORIES"]);
export type LeagueType = z.infer<typeof leagueTypeSchema>;

export const leagueHorizonSchema = z.enum(["REDRAFT", "KEEPER", "DYNASTY"]);
export type LeagueHorizon = z.infer<typeof leagueHorizonSchema>;

export const draftTypeSchema = z.enum(["REAL", "MOCK", "DEMO"]);
export type DraftType = z.infer<typeof draftTypeSchema>;

export const draftStatusSchema = z.enum(["SETUP", "ACTIVE", "PAUSED", "COMPLETED", "ABANDONED"]);
export type DraftStatus = z.infer<typeof draftStatusSchema>;

export const draftEventTypeSchema = z.enum([
  "DRAFT_STARTED",
  "PLAYER_DRAFTED",
  "PICK_UNDONE",
  "DRAFT_PAUSED",
  "DRAFT_RESUMED",
  "DRAFT_COMPLETED",
]);
export type DraftEventType = z.infer<typeof draftEventTypeSchema>;

export const positionSchema = z.enum(["PG", "SG", "SF", "PF", "C", "G", "F", "UTIL", "BENCH"]);
export type Position = z.infer<typeof positionSchema>;

export const directionSchema = z.enum(["HIGHER_BETTER", "LOWER_BETTER"]);
export type Direction = z.infer<typeof directionSchema>;

export const availabilitySchema = z.enum(["ACTIVE", "INJURED", "SUSPENDED", "UNSIGNED", "RETIRED"]);
export type Availability = z.infer<typeof availabilitySchema>;

export const preferenceListTypeSchema = z.enum(["FAVORITE", "DISLIKED", "TARGET", "AVOID"]);
export type PreferenceListType = z.infer<typeof preferenceListTypeSchema>;

/**
 * Phase 1 enums (BUILD_SPEC.md section 4.2 data model + Phase 1 additions —
 * see docs/adr/0005-phase1-data-model.md). Mirrored in
 * services/analytics/app/domain/enums.py and packages/db/prisma/schema.prisma.
 */

/** Narrower than `positionSchema` above — a player is only ever eligible at
 * a real position, not a roster-slot concept like UTIL/BENCH. */
export const eligiblePositionSchema = z.enum(["PG", "SG", "SF", "PF", "C", "G", "F"]);
export type EligiblePosition = z.infer<typeof eligiblePositionSchema>;

export const statScopeSchema = z.enum(["NBA", "COLLEGE", "INTERNATIONAL"]);
export type StatScope = z.infer<typeof statScopeSchema>;

export const sourceAdapterTypeSchema = z.enum(["FILE", "API"]);
export type SourceAdapterType = z.infer<typeof sourceAdapterTypeSchema>;

export const ingestionRunStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "PARTIAL",
]);
export type IngestionRunStatus = z.infer<typeof ingestionRunStatusSchema>;

export const rawRecordStatusSchema = z.enum(["PENDING", "VALIDATED", "QUARANTINED", "PUBLISHED"]);
export type RawRecordStatus = z.infer<typeof rawRecordStatusSchema>;

export const identityMatchStatusSchema = z.enum(["CONFIRMED", "CANDIDATE", "REJECTED"]);
export type IdentityMatchStatus = z.infer<typeof identityMatchStatusSchema>;

export const identityMatchMethodSchema = z.enum(["PROVIDER_ID", "NAME_DOB", "MANUAL"]);
export type IdentityMatchMethod = z.infer<typeof identityMatchMethodSchema>;

export const signalTypeSchema = z.enum([
  "INJURY",
  "TRADE",
  "STARTER_CHANGE",
  "ROLE_UP",
  "ROLE_DOWN",
]);
export type SignalType = z.infer<typeof signalTypeSchema>;

export const overrideStatusSchema = z.enum(["ACTIVE", "EXPIRED", "SUPERSEDED", "REVOKED"]);
export type OverrideStatus = z.infer<typeof overrideStatusSchema>;

export const projectionModelStatusSchema = z.enum(["DRAFT", "ACTIVE", "DEPRECATED", "ARCHIVED"]);
export type ProjectionModelStatus = z.infer<typeof projectionModelStatusSchema>;

export const projectionRunStatusSchema = z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]);
export type ProjectionRunStatus = z.infer<typeof projectionRunStatusSchema>;
