-- Phase 3E2: Private result-sharing capabilities (ADR 0016 R4-R5)
-- New append-safe table; preserves every existing draft and analysis.
-- One active row per draft (draftId UNIQUE); token digests unique; FK cascade
-- on draft delete; legacy drafts.shareTokenHash untouched (stays NULL).

CREATE TABLE "draft_share_capabilities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "draftId" UUID NOT NULL,
    "tokenDigest" VARCHAR(64) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "revokedAt" TIMESTAMPTZ,
    "lastAccessedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "draft_share_capabilities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "draft_share_capabilities_tokenDigest_check" CHECK ("tokenDigest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "draft_share_capabilities_version_check" CHECK ("version" >= 1)
);

-- One active share per draft; digests globally unique (no indexing of raw tokens anywhere).
CREATE UNIQUE INDEX "draft_share_capabilities_draftId_key" ON "draft_share_capabilities"("draftId");
CREATE UNIQUE INDEX "draft_share_capabilities_tokenDigest_key" ON "draft_share_capabilities"("tokenDigest");

-- Lookup/cleanup coverage: active-share expiry scan.
CREATE INDEX "draft_share_capabilities_expiresAt_idx" ON "draft_share_capabilities"("expiresAt");
CREATE INDEX "draft_share_capabilities_active_expiry_idx" ON "draft_share_capabilities"("expiresAt") WHERE "revokedAt" IS NULL;

-- Explicit FK behavior: deleting a draft removes its share capability.
ALTER TABLE "draft_share_capabilities" ADD CONSTRAINT "draft_share_capabilities_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
