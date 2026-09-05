-- AlterTable
ALTER TABLE "draft_teams" ADD COLUMN     "cpuPersonalitySnapshot" JSONB;

-- AlterTable
ALTER TABLE "drafts" ADD COLUMN     "simulationSeed" VARCHAR(64);
