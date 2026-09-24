-- Spec §4.7: the flame is quest-driven now. Legacy streaks (earned under the
-- old paid-action-plus-received-tip rule) are reset so nobody carries a stale
-- day count or ladder marker into the new system; the next clear starts at
-- day 1. No backfill.
UPDATE users SET streak = NULL WHERE streak IS NOT NULL;
UPDATE "Streak" SET "endedAt" = now_utc() WHERE type = 'FLAME' AND "endedAt" IS NULL;
