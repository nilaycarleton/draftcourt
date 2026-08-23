-- CreateEnum
CREATE TYPE "DraftType" AS ENUM ('REAL', 'MOCK', 'DEMO');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('SETUP', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "DraftEventType" AS ENUM ('DRAFT_STARTED', 'PLAYER_DRAFTED', 'PICK_UNDONE', 'DRAFT_PAUSED', 'DRAFT_RESUMED', 'DRAFT_COMPLETED');

-- CreateTable
CREATE TABLE "drafts" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "leagueId" UUID NOT NULL,
    "type" "DraftType" NOT NULL DEFAULT 'REAL',
    "status" "DraftStatus" NOT NULL DEFAULT 'SETUP',
    "currentSequence" INTEGER NOT NULL DEFAULT 0,
    "nextOverallPick" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 0,
    "settingsSnapshot" JSONB NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "projectionRunId" UUID,
    "adpSnapshotId" UUID,
    "shareTokenHash" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_teams" (
    "id" UUID NOT NULL,
    "draftId" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "displayName" TEXT NOT NULL,
    "isUserTeam" BOOLEAN NOT NULL DEFAULT false,
    "cpuStrategy" TEXT,

    CONSTRAINT "draft_teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_events" (
    "id" UUID NOT NULL,
    "draftId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventType" "DraftEventType" NOT NULL,
    "actorUserId" UUID,
    "teamSlot" INTEGER,
    "playerId" UUID,
    "round" INTEGER,
    "pickInRound" INTEGER,
    "causationEventId" UUID,
    "idempotencyKey" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_roster_assignments" (
    "id" UUID NOT NULL,
    "draftId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "teamSlot" INTEGER NOT NULL,
    "playerId" UUID NOT NULL,
    "slotPosition" "RosterPosition" NOT NULL,
    "isBench" BOOLEAN NOT NULL DEFAULT false,
    "isKeeper" BOOLEAN NOT NULL DEFAULT false,
    "assignedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "draft_roster_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_snapshots" (
    "id" UUID NOT NULL,
    "draftId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "userTeamSlot" INTEGER NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "inputChecksum" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "payload" JSONB NOT NULL,
    "requestedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "drafts_ownerId_updatedAt_idx" ON "drafts"("ownerId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "drafts_leagueId_idx" ON "drafts"("leagueId");

-- CreateIndex
CREATE UNIQUE INDEX "draft_teams_draftId_slot_key" ON "draft_teams"("draftId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "draft_events_draftId_sequence_key" ON "draft_events"("draftId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "draft_events_draftId_idempotencyKey_key" ON "draft_events"("draftId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "draft_roster_assignments_eventId_key" ON "draft_roster_assignments"("eventId");

-- CreateIndex
CREATE INDEX "draft_roster_assignments_draftId_teamSlot_idx" ON "draft_roster_assignments"("draftId", "teamSlot");

-- CreateIndex
CREATE UNIQUE INDEX "draft_roster_assignments_draftId_playerId_key" ON "draft_roster_assignments"("draftId", "playerId");

-- CreateIndex
CREATE INDEX "recommendation_snapshots_draftId_sequence_idx" ON "recommendation_snapshots"("draftId", "sequence" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "recommendation_snapshots_draftId_sequence_inputChecksum_key" ON "recommendation_snapshots"("draftId", "sequence", "inputChecksum");

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "leagues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_teams" ADD CONSTRAINT "draft_teams_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_events" ADD CONSTRAINT "draft_events_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_events" ADD CONSTRAINT "draft_events_causationEventId_fkey" FOREIGN KEY ("causationEventId") REFERENCES "draft_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_roster_assignments" ADD CONSTRAINT "draft_roster_assignments_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_roster_assignments" ADD CONSTRAINT "draft_roster_assignments_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "draft_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_snapshots" ADD CONSTRAINT "recommendation_snapshots_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
