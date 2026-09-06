-- Phase 3E1: Deterministic post-draft analysis and saved history
-- Adds draft_analyses table with versioned, checksum-addressed, append-only rows

CREATE TABLE "draft_analyses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "draftId" UUID NOT NULL,
    "analysisVersion" VARCHAR(32) NOT NULL,
    "analysisVersionInt" INTEGER NOT NULL DEFAULT 1,
    "inputChecksum" VARCHAR(64) NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "projectionRunId" UUID,
    "adpSnapshotId" UUID,
    "preferenceSnapshotChecksum" TEXT,
    "simulationSeed" VARCHAR(64),
    "grade" VARCHAR(4) NOT NULL,
    "gradeScore" DOUBLE PRECISION NOT NULL,
    "gradeComponents" JSONB NOT NULL,
    "assumptions" JSONB NOT NULL,
    "categoryStrengths" JSONB NOT NULL,
    "positionStrengths" JSONB NOT NULL,
    "roundByRound" JSONB NOT NULL,
    "bestValuePick" JSONB,
    "biggestReach" JSONB,
    "projectedStanding" JSONB NOT NULL,
    "categoryWinProbs" JSONB,
    "dataFreshness" JSONB NOT NULL,
    "generatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "draft_analyses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "draft_analyses_gradeScore_check" CHECK ("gradeScore" >= 0 AND "gradeScore" <= 100),
    CONSTRAINT "draft_analyses_analysisVersion_check" CHECK ("analysisVersion" ~ '^[0-9]+\.[0-9]+\.[0-9]+$')
);

-- Foreign keys
ALTER TABLE "draft_analyses" ADD CONSTRAINT "draft_analyses_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "draft_analyses" ADD CONSTRAINT "draft_analyses_projectionRunId_fkey" FOREIGN KEY ("projectionRunId") REFERENCES "projection_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Idempotency and versioning
CREATE UNIQUE INDEX "draft_analyses_draftId_analysisVersion_inputChecksum_key" ON "draft_analyses"("draftId", "analysisVersion", "inputChecksum");
CREATE UNIQUE INDEX "draft_analyses_draftId_analysisVersion_key" ON "draft_analyses"("draftId", "analysisVersion");

-- Query indexes
CREATE INDEX "draft_analyses_draftId_generatedAt_idx" ON "draft_analyses"("draftId", "generatedAt" DESC);
CREATE INDEX "draft_analyses_projectionRunId_idx" ON "draft_analyses"("projectionRunId");
