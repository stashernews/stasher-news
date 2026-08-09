-- Feed filter defaults move to -0.002 XMR (-2000000000 piconeros) so downvoted
-- content is visible by default (posts + comments for users, posts for Sub).
-- Existing rows keep their stored values (no backfill); only the defaults change.
ALTER TABLE "users" ALTER COLUMN "postsPiconerosFilter" SET DEFAULT -2000000000;
ALTER TABLE "users" ALTER COLUMN "commentsPiconerosFilter" SET DEFAULT -2000000000;
ALTER TABLE "Sub" ALTER COLUMN "postsPiconerosFilter" SET DEFAULT -2000000000;
