ALTER TABLE "Streak" ADD COLUMN "flameTier" INTEGER;
ALTER TABLE "users" ADD COLUMN "bestFlameTier" INTEGER;

-- A boost credit halves in value, so every spendable credit becomes two with
-- the same expiry and held value is unchanged.
INSERT INTO "StreakReward" ("userId", "streakId", created_at, "grantedAt", "expiresAt", "type")
SELECT "userId", "streakId", created_at, "grantedAt", "expiresAt", "type"
FROM "StreakReward"
WHERE "type" = 'BOOST'::"StreakRewardType"
  AND "consumedAt" IS NULL
  AND "expiresAt" > now_utc();
