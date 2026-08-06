-- Dev-only cleanup: remove automated-test artifacts (load tests + rewards
-- distribution fixture runs) from the observation tables and their users.
-- Real platform activity (real 64-hex tx hashes) is untouched.
--
-- Run with:
--   docker compose exec -T db psql -U sn -d stackernews -f - < scripts/cleanup-dev-test-data.sql

BEGIN;

-- 1. observation rows with fake tx hashes (load test: 0x0000.../pending-0000...;
--    distribution tests: dist-test-...)
DELETE FROM "ObservedTip"
WHERE "txHash" LIKE '0x%' OR "txHash" LIKE 'pending-%' OR "txHash" LIKE 'dist-test-%';

DELETE FROM "ObservedBurn"
WHERE "txHash" LIKE 'dist-test-%';

-- 2. monero account fixtures of the test users (subaddresses + view keys first,
--    since they reference the account)
DELETE FROM "SubaddressIndex"
WHERE "accountId" IN (
  SELECT id FROM "MoneroAccount"
  WHERE "ownerUserId" IN (SELECT id FROM users WHERE name = 'loadtest_author' OR name LIKE 'dist-test-%')
);

DELETE FROM "MoneroViewKey"
WHERE "accountId" IN (
  SELECT id FROM "MoneroAccount"
  WHERE "ownerUserId" IN (SELECT id FROM users WHERE name = 'loadtest_author' OR name LIKE 'dist-test-%')
);

DELETE FROM "MoneroAccount"
WHERE "ownerUserId" IN (SELECT id FROM users WHERE name = 'loadtest_author' OR name LIKE 'dist-test-%');

-- 3. any payIns / items of the test users (items after observations are gone;
--    user deletion cascades the rest)
DELETE FROM "PayIn"
WHERE "userId" IN (SELECT id FROM users WHERE name = 'loadtest_author' OR name LIKE 'dist-test-%');

DELETE FROM "Item"
WHERE "userId" IN (SELECT id FROM users WHERE name = 'loadtest_author' OR name LIKE 'dist-test-%');

DELETE FROM users
WHERE name = 'loadtest_author' OR name LIKE 'dist-test-%';

COMMIT;
