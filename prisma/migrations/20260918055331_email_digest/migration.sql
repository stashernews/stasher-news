-- AlterTable
ALTER TABLE "users" ADD COLUMN     "emailCiphertext" TEXT,
ADD COLUMN     "emailDigestSentAt" TIMESTAMP(3),
ADD COLUMN     "emailNotifications" BOOLEAN NOT NULL DEFAULT true;

-- Daily drip for the weekly email digest, cron-owned. The handler runs once a
-- day and sends at most EMAIL_DIGEST_DAILY_BUDGET emails (default 60), leaving
-- the rest of Resend's shared 100/day quota for magic-code login email. The
-- handler does NOT self-requeue; a failed run self-heals at the next daily tick.
INSERT INTO pgboss.schedule (name, cron, timezone, options) VALUES
  ('emailDigest', '0 15 * * *', 'UTC', '{"retryLimit":3,"retryDelay":60,"retryBackoff":true}')
ON CONFLICT (name) DO NOTHING;
