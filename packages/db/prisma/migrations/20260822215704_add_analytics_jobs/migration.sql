-- CreateEnum
CREATE TYPE "AnalyticsJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMEOUT');

-- CreateTable
CREATE TABLE "analytics_jobs" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "AnalyticsJobStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT,
    "request" JSONB,
    "result" JSONB,
    "errorCode" TEXT,
    "traceId" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ NOT NULL,
    "finishedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analytics_jobs_status_createdAt_idx" ON "analytics_jobs"("status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "analytics_jobs_kind_idempotencyKey_key" ON "analytics_jobs"("kind", "idempotencyKey");
