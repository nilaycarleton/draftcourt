-- DropIndex
DROP INDEX "players_displayName_trgm_idx";

-- AlterTable
ALTER TABLE "player_projections" ADD COLUMN     "fantasyPoints" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "player_projections_runId_fantasyPoints_idx" ON "player_projections"("runId", "fantasyPoints");
