-- Badge re-theme: the streak is now a FLAME; gun/horse streaks were never
-- granted by any code and are removed with their columns. COIN and VERIFIED
-- are badge-notification streak rows (first tip in a 24h window / wallet
-- registration) managed by Task 4.
--
-- PostgreSQL (16.x included) has no `ALTER TYPE ... DROP VALUE`, so the enum
-- is recreated (Global Constraints fallback): the old labels COWBOY_HAT/GUN/
-- HORSE cannot be cast to the new set, so the USING clause maps COWBOY_HAT to
-- FLAME explicitly (rows are never GUN/HORSE — nothing grants them — but the
-- DELETE is kept for safety, before the old enum is dropped).

DELETE FROM "Streak" WHERE type IN ('GUN', 'HORSE');

ALTER TABLE "Streak" ALTER COLUMN type DROP DEFAULT;

CREATE TYPE "StreakType_new" AS ENUM ('FLAME', 'COIN', 'VERIFIED');

ALTER TABLE "Streak" ALTER COLUMN type TYPE "StreakType_new"
USING CASE type WHEN 'COWBOY_HAT' THEN 'FLAME' ELSE type::text END::"StreakType_new";

DROP TYPE "StreakType";

ALTER TYPE "StreakType_new" RENAME TO "StreakType";

ALTER TABLE "Streak" ALTER COLUMN type SET DEFAULT 'FLAME';

DROP INDEX IF EXISTS "users_gunStreak_idx";
DROP INDEX IF EXISTS "users_horseStreak_idx";
ALTER TABLE users DROP COLUMN "gunStreak", DROP COLUMN "horseStreak";
