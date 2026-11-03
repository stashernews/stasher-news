-- AlterTable
ALTER TABLE "HealthSnapshot" ADD COLUMN     "adminEdgeCheckedAt" TIMESTAMP(3),
ADD COLUMN     "adminEdgeOk" BOOLEAN;

-- CreateTable
CREATE TABLE "SiteSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "itemSpamIntervalMinutes" INTEGER NOT NULL DEFAULT 10,
    "spamEscalationNumerator" INTEGER NOT NULL DEFAULT 3,
    "spamEscalationDenominator" INTEGER NOT NULL DEFAULT 2,
    "freePostsPerMonth" INTEGER NOT NULL DEFAULT 1,
    "freeCommentsPerWeek" INTEGER NOT NULL DEFAULT 1,
    "homepagePostsFilterPiconeros" BIGINT NOT NULL DEFAULT -25000000000,
    "defaultPostsFilterPiconeros" BIGINT NOT NULL DEFAULT -25000000000,
    "defaultCommentsFilterPiconeros" BIGINT NOT NULL DEFAULT -25000000000,
    "maxItemTurfs" INTEGER NOT NULL DEFAULT 5,
    "itemEditSeconds" INTEGER NOT NULL DEFAULT 600,
    "anonPostFeeMultiplier" INTEGER NOT NULL DEFAULT 10,
    "anonCommentFeeMultiplier" INTEGER NOT NULL DEFAULT 3,
    "trustSeedWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.83,
    "trustMaxDepth" INTEGER NOT NULL DEFAULT 40,
    "trustPicoMin" INTEGER NOT NULL DEFAULT 1001,
    "trustAgainstPicoMin" INTEGER NOT NULL DEFAULT 1000,
    "trustIrrelevantCumulative" DOUBLE PRECISION NOT NULL DEFAULT 0.001,
    "verifiedBadgeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "nostrSocialPosting" BOOLEAN,
    "opsSweepEnabled" BOOLEAN,
    "newsletterAutoSend" BOOLEAN,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteGateCode" (
    "id" SERIAL NOT NULL,
    "label" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "InviteGateCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminConfigChange" (
    "id" BIGSERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applyId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "store" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "targetId" TEXT,
    "oldValue" TEXT NOT NULL,
    "newValue" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "applied" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AdminConfigChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InviteGateCode_tokenHash_key" ON "InviteGateCode"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminConfigChange_createdAt_idx" ON "AdminConfigChange"("createdAt");

INSERT INTO "SiteSettings" (id) VALUES (1) ON CONFLICT DO NOTHING;
-- Prisma supplies @updatedAt on subsequent writes.
ALTER TABLE "SiteSettings" ALTER COLUMN "updatedAt" DROP DEFAULT;

CREATE FUNCTION admin_config_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.applied = true AND NEW.applied = false
       AND (to_jsonb(OLD) - 'applied') = (to_jsonb(NEW) - 'applied') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'AdminConfigChange is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER admin_config_append_only
BEFORE UPDATE OR DELETE ON "AdminConfigChange"
FOR EACH ROW EXECUTE FUNCTION admin_config_append_only();
