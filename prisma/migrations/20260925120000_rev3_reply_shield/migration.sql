-- rev 3: banked reply credits + the golden flame shield.
-- ADD VALUE is transaction-safe on PG12+ as long as the value is not used in
-- the same transaction (nothing inserts REPLY here).
ALTER TYPE "StreakRewardType" ADD VALUE IF NOT EXISTS 'REPLY';

ALTER TABLE "Streak" ADD COLUMN "goldActive" BOOLEAN NOT NULL DEFAULT false;

-- Live runs that already passed a cycle day 4 (levels 4, 11, 18, ...) are
-- armed: every active run at level >= 4 has passed level 4.
UPDATE "Streak" s
SET "goldActive" = true
FROM users u
WHERE u.id = s."userId"
  AND s."type" = 'FLAME'
  AND s."endedAt" IS NULL
  AND u.streak >= 4;
