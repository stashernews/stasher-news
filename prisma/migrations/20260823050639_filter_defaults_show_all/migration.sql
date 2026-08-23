-- Feed filter defaults: users default to -∞ (show all, NULL); the turf default
-- and the logged-out homepage floor move to -0.1 XMR (-100000000000 piconeros)
-- so a single downvote can never hide a post. Rows still at the old default
-- (-0.002 XMR = -2000000000) are backfilled; deliberate customizations are kept.
ALTER TABLE "users" ALTER COLUMN "postsPiconerosFilter" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "commentsPiconerosFilter" DROP DEFAULT;
ALTER TABLE "Sub" ALTER COLUMN "postsPiconerosFilter" SET DEFAULT -100000000000;
UPDATE "users" SET "postsPiconerosFilter" = NULL WHERE "postsPiconerosFilter" = -2000000000;
UPDATE "users" SET "commentsPiconerosFilter" = NULL WHERE "commentsPiconerosFilter" = -2000000000;
UPDATE "Sub" SET "postsPiconerosFilter" = -100000000000 WHERE "postsPiconerosFilter" = -2000000000;
