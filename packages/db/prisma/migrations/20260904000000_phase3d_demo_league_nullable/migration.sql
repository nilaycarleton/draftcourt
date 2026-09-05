-- Phase 3D: Make leagueId nullable for demo drafts
-- Demo drafts don't require a persistent league

ALTER TABLE "drafts" ALTER COLUMN "leagueId" DROP NOT NULL;