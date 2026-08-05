-- StealthNews: replace the seeded Stacker News contributor account (k00b) with
-- the Stasher.News verified contributor account (untraceable), reusing the
-- reserved founder id 616 (RESERVED_MAX_USER_ID = 615, see lib/constants.js).
--
-- Renaming in place keeps every foreign key (notably Sub.userId on the default
-- turfs seeded by 20260802120000_seed_default_territories) pointing at id 616,
-- so default-turf ownership transfers to untraceable with no cascade deletes
-- and no re-pointing. Idempotent: safe to re-run.

-- Rename k00b -> untraceable at id 616, only if the target name isn't taken.
UPDATE "users" SET name = 'untraceable'
WHERE id = 616 AND name = 'k00b'
  AND NOT EXISTS (SELECT 1 FROM "users" WHERE name = 'untraceable');

-- Fresh-install fallback: ensure untraceable exists at id 616 even if the
-- original seed was skipped (e.g. a clone that never ran it).
INSERT INTO "users" ("id", "name")
VALUES (616, 'untraceable')
ON CONFLICT DO NOTHING;

-- Remove the other Stacker News contributor accounts that may have been seeded
-- or registered on this instance. Only rows that own no content (no posts, no
-- comments, no subs, no custodial balances, no auth bindings) are deleted; any
-- account with content is left for manual review rather than cascade-deleted.
DELETE FROM "users" u
WHERE u.name IN ('k00b', 'kr', 'ek', 'WeAreAllSatoshi', 'rleed', 'bitcoinplebdev',
                 'benthecarman', 'stargut', 'mz', 'btcbagehot', 'felipe',
                 'benalleng', 'rblb', 'Scroogey', 'SimpleStacker', 'klk',
                 'brymut', 'abhishandy', 'sox', 'scoresby')
  AND u.id <> 616
  AND NOT EXISTS (SELECT 1 FROM "Item" WHERE "userId" = u.id)
  AND NOT EXISTS (SELECT 1 FROM "Sub" WHERE "userId" = u.id)
  AND NOT EXISTS (SELECT 1 FROM "Earn" WHERE "userId" = u.id)
  AND NOT EXISTS (SELECT 1 FROM "Invite" WHERE "userId" = u.id)
  AND NOT EXISTS (SELECT 1 FROM "accounts" WHERE "user_id" = u.id);
