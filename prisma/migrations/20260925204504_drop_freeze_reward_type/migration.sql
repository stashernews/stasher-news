-- Drop the FREEZE reward type. Rev 3 replaced the streak-freeze ladder reward
-- with the golden flame shield (Streak.goldActive); nothing grants or reads
-- FREEZE and no rows use it. PostgreSQL enums are append-only, so the value is
-- removed by recreating the type (the standard swap Prisma emits itself).
CREATE TYPE "StreakRewardType_new" AS ENUM ('POST', 'REPLY', 'TURF_DISCOUNT');

ALTER TABLE "StreakReward" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "StreakReward" ALTER COLUMN "type" TYPE "StreakRewardType_new" USING ("type"::text::"StreakRewardType_new");
ALTER TABLE "StreakReward" ALTER COLUMN "type" SET DEFAULT 'POST'::"StreakRewardType_new";

ALTER TYPE "StreakRewardType" RENAME TO "StreakRewardType_old";
ALTER TYPE "StreakRewardType_new" RENAME TO "StreakRewardType";
DROP TYPE "StreakRewardType_old";
