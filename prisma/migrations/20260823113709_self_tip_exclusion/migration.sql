-- CreateEnum
CREATE TYPE "TipExclusionReason" AS ENUM ('DIRECT_SELF_TIP', 'SELF_SEND');

-- CreateEnum
CREATE TYPE "AbuseSignalKind" AS ENUM ('SELF_TIP_EXCLUDED', 'SELF_SEND_EXCLUDED');

-- AlterEnum
ALTER TYPE "ObservedState" ADD VALUE 'EXCLUDED';

-- AlterTable
ALTER TABLE "ObservedTip" ADD COLUMN     "exclusionReason" "TipExclusionReason";

-- CreateTable
CREATE TABLE "AbuseSignal" (
    "id" BIGSERIAL NOT NULL,
    "kind" "AbuseSignalKind" NOT NULL,
    "subjectUserId" INTEGER NOT NULL,
    "actorUserId" INTEGER,
    "tipId" BIGINT NOT NULL,
    "postId" INTEGER NOT NULL,
    "subName" CITEXT,
    "piconeros" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "details" JSONB,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,

    CONSTRAINT "AbuseSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AbuseSignal_tipId_key" ON "AbuseSignal"("tipId");

-- CreateIndex
CREATE INDEX "AbuseSignal_subjectUserId_idx" ON "AbuseSignal"("subjectUserId");

-- CreateIndex
CREATE INDEX "AbuseSignal_kind_detectedAt_idx" ON "AbuseSignal"("kind", "detectedAt");

-- AddForeignKey
ALTER TABLE "AbuseSignal" ADD CONSTRAINT "AbuseSignal_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbuseSignal" ADD CONSTRAINT "AbuseSignal_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbuseSignal" ADD CONSTRAINT "AbuseSignal_tipId_fkey" FOREIGN KEY ("tipId") REFERENCES "ObservedTip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbuseSignal" ADD CONSTRAINT "AbuseSignal_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
