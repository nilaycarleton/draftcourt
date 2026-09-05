-- Phase 3D: Guest Demo Draft Capabilities
-- Adds demo_draft_capabilities table and demo-related columns to drafts

-- Make ownerId nullable for DEMO drafts
ALTER TABLE "drafts" ALTER COLUMN "ownerId" DROP NOT NULL;

-- Add demo capability reference columns
ALTER TABLE "drafts" ADD COLUMN "demoCapabilityId" UUID UNIQUE;
ALTER TABLE "drafts" ADD COLUMN "demoTokenHash" VARCHAR(128);

-- Create demo_draft_capabilities table
CREATE TABLE "demo_draft_capabilities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "draftId" UUID NOT NULL UNIQUE,
    "tokenHash" VARCHAR(128) NOT NULL,
    "rateLimitKey" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "revokedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "demo_draft_capabilities_pkey" PRIMARY KEY ("id")
);

-- Foreign key from capabilities to drafts (CASCADE on delete)
ALTER TABLE "demo_draft_capabilities"
    ADD CONSTRAINT "demo_draft_capabilities_draftId_fkey"
    FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE CASCADE;

-- Foreign key from drafts to capabilities (SET NULL on delete)
ALTER TABLE "drafts"
    ADD CONSTRAINT "drafts_demoCapabilityId_fkey"
    FOREIGN KEY ("demoCapabilityId") REFERENCES "demo_draft_capabilities"("id") ON DELETE SET NULL;

-- Index for cleanup job
CREATE INDEX "demo_draft_capabilities_expiresAt_idx" ON "demo_draft_capabilities"("expiresAt");