-- AlterTable
ALTER TABLE "HealthSnapshot" ADD COLUMN     "newsletterConfigured" BOOLEAN,
ADD COLUMN     "newsletterContactsActive" INTEGER,
ADD COLUMN     "newsletterLastSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "newsletterOptIn" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "newsletterSuppressed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "resendContactId" TEXT;

-- CreateTable
CREATE TABLE "NewsletterCampaign" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "periodKey" TEXT NOT NULL,
    "resendBroadcastId" TEXT,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "stats" JSONB,

    CONSTRAINT "NewsletterCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NewsletterCampaign_periodKey_key" ON "NewsletterCampaign"("periodKey");

-- Daily reconcile + weekly-tick (14-day watermark) newsletter jobs are
-- cron-owned; handlers never self-requeue (repo rule). The campaign handler
-- guards on a 14-day watermark over NewsletterCampaign.sentAt.
INSERT INTO pgboss.schedule (name, cron, timezone, options) VALUES
  ('newsletterSync', '0 16 * * *', 'UTC', '{"retryLimit":3,"retryDelay":60,"retryBackoff":true}'),
  ('newsletterCampaign', '0 16 * * 1', 'UTC', '{"retryLimit":3,"retryDelay":60,"retryBackoff":true}')
ON CONFLICT (name) DO NOTHING;

