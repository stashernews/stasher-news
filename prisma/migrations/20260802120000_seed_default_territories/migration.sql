-- Seed default platform territories so fresh StasherNews deployments have somewhere
-- to post (posting requires a territory: see subSelectSchemaMembers in lib/validate.js
-- which enforces subNames.min(1) and validates each sub's existence + postTypes).
--
-- Set: bitcoin, tech, meta, jobs, monero. This replaces upstream's DEFAULT_SUBS
-- (bitcoin, nostr, tech, meta, jobs): 'nostr' is dropped and 'monero' added to
-- match StasherNews. lib/constants.js DEFAULT_SUBS is updated to mirror this set.
--
-- All are free ONCE territories (never billed — territoryBilling refuses ONCE
-- subs), billingStatus PAID, status ACTIVE, supporting every fork PostType
-- (LINK, DISCUSSION, JOB, POLL). Idempotent: safe to re-run.

-- Owner: reserved k00b admin (USER_ID.k00b = 616, RESERVED_MAX_USER_ID = 615).
-- Insert only if neither id 616 nor name 'k00b' is already taken.
INSERT INTO "users" ("id", "name")
VALUES (616, 'k00b')
ON CONFLICT DO NOTHING;

-- Reference the owner by name so the sub insert works whether k00b landed at id 616
-- or was skipped because a 'k00b' by name already existed at another id.
INSERT INTO "Sub" (
  "name", "userId", "postTypes", "rankingType",
  "billingType", "billingCost", "status", "billingStatus"
)
SELECT
  v.name,
  u.id,
  ARRAY['LINK', 'DISCUSSION', 'JOB', 'POLL']::"PostType"[],
  'WOT',
  'ONCE',
  0,
  'ACTIVE',
  'PAID'
FROM (VALUES
  ('bitcoin'),
  ('tech'),
  ('meta'),
  ('jobs'),
  ('monero')
) AS v(name)
CROSS JOIN "users" u
WHERE u.name = 'k00b'
ON CONFLICT (name) DO NOTHING;
