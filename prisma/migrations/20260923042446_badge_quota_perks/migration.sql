-- AlterTable
ALTER TABLE "Streak" ADD COLUMN     "postCreditsGranted" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "FlamePostCredit" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL,
    "streakId" INTEGER,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "itemId" INTEGER,

    CONSTRAINT "FlamePostCredit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FlamePostCredit_userId_consumedAt_expiresAt_idx" ON "FlamePostCredit"("userId", "consumedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "FlamePostCredit_expiresAt_idx" ON "FlamePostCredit"("expiresAt");

-- CreateIndex
CREATE INDEX "ObservedTip_tipperId_state_detectedAt_idx" ON "ObservedTip"("tipperId", "state", "detectedAt");

-- AddForeignKey
ALTER TABLE "FlamePostCredit" ADD CONSTRAINT "FlamePostCredit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
