-- Seed the 'anon' system account at its reserved id (USER_ID.anon = 27,
-- lib/constants.js). Logged-out posting/comments are attributed to this id
-- (api/payIn/index.js me ??= { id: USER_ID.anon }), and Item.userId has a hard
-- FK to users — without this row anonymous posting fails ('user not found'
-- during the fee prospect, or an FK violation at Item creation). Like the
-- sibling 20260820000000_seed_sn_system_user migration, the row was previously
-- supplied only by the legacy dev dump; seed it here idempotently.

INSERT INTO "users" ("id", "name")
VALUES (27, 'anon')
ON CONFLICT DO NOTHING;
