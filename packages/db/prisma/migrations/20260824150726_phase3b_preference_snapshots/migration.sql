-- AlterTable
ALTER TABLE "drafts" ADD COLUMN     "overrideProfileId" UUID,
ADD COLUMN     "preferenceSnapshot" JSONB,
ADD COLUMN     "preferenceSnapshotChecksum" TEXT,
ADD COLUMN     "preferenceSnapshotVersion" INTEGER,
ADD COLUMN     "preferenceSourceProfileId" UUID;

-- AlterTable
ALTER TABLE "leagues" ADD COLUMN     "preferredProfileId" UUID;

-- AddForeignKey
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_preferredProfileId_fkey" FOREIGN KEY ("preferredProfileId") REFERENCES "user_preference_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_overrideProfileId_fkey" FOREIGN KEY ("overrideProfileId") REFERENCES "user_preference_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_preferenceSourceProfileId_fkey" FOREIGN KEY ("preferenceSourceProfileId") REFERENCES "user_preference_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
