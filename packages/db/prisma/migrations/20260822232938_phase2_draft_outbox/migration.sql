-- CreateTable
CREATE TABLE "draft_outbox" (
    "id" UUID NOT NULL,
    "draftId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "payload" JSONB,
    "processedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "draft_outbox_processedAt_createdAt_idx" ON "draft_outbox"("processedAt", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "draft_outbox_draftId_sequence_idx" ON "draft_outbox"("draftId", "sequence" DESC);

-- AddForeignKey
ALTER TABLE "draft_outbox" ADD CONSTRAINT "draft_outbox_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
