-- Day-level idempotency guard for the quest-streak evaluation (spec §4.5):
-- a re-run for the same UTC day must not advance, hold, or consume twice.
ALTER TABLE "Streak" ADD COLUMN "lastEvaluatedDay" TIMESTAMP(3);
