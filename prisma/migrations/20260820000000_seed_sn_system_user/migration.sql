-- Seed the 'sn' system admin account at its reserved id (USER_ID.sn = 4502,
-- lib/constants.js). SN_ADMIN_IDS = [USER_ID.untraceable, USER_ID.sn] and the
-- account is referenced directly by id across the codebase, so every install
-- needs this row. It was previously supplied only by the legacy dev dump
-- (docker/db/000_seed.sql.gz); now that migrations are the sole schema/data
-- source, seed it here idempotently. The sibling admin id 616 (stasher) is
-- already produced by the 20260802120000 / 20260805100000 / 20260811100000 /
-- 20260818000000 migration chain (k00b -> untraceable -> stasher).

INSERT INTO "users" ("id", "name")
VALUES (4502, 'sn')
ON CONFLICT DO NOTHING;
