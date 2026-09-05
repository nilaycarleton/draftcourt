-- Phase 3D fix: tokenHash length insufficient for PBKDF2 100k + 32-byte salt/key (136 chars). Increase to 255.
ALTER TABLE "demo_draft_capabilities" ALTER COLUMN "tokenHash" TYPE VARCHAR(255);
ALTER TABLE "drafts" ALTER COLUMN "demoTokenHash" TYPE VARCHAR(255);
