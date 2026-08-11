-- StasherNews: rename the verified contributor nym untraceable -> stasher at
-- id 616 (RESERVED_MAX_USER_ID = 615, see lib/constants.js). Same rename-in-place
-- pattern as 20260805100000_stasher_contributor: every foreign key (notably
-- Sub.userId on the default turfs) keeps pointing at id 616, so default-turf
-- ownership transfers with no cascade deletes and no re-pointing. Idempotent:
-- safe to re-run.

-- Rename untraceable -> stasher at id 616, only if the target name isn't taken.
UPDATE "users" SET name = 'stasher'
WHERE id = 616 AND name = 'untraceable'
  AND NOT EXISTS (SELECT 1 FROM "users" WHERE name = 'stasher');

-- Fresh-install fallback: ensure stasher exists at id 616.
INSERT INTO "users" ("id", "name")
VALUES (616, 'stasher')
ON CONFLICT DO NOTHING;
