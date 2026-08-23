-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "clerkUserId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "plan" TEXT NOT NULL DEFAULT 'free',
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_clerkUserId_key" ON "users"("clerkUserId");
