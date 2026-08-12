-- StasherNews: seed three more default platform territories (crypto, bounties,
-- memes) so fresh deployments have somewhere to post. Complements
-- 20260802120000_seed_default_territories (bitcoin, tech, meta, jobs, monero).
--
-- All are free ONCE territories (never billed — territoryBilling refuses ONCE
-- subs), billingStatus PAID, status ACTIVE, supporting every fork PostType
-- (LINK, DISCUSSION, JOB, POLL, BOUNTY — matching the postTypes the live default
-- turfs carry after the 20260812000000_bounties backfill). Idempotent: safe to
-- re-run.
--
-- Owner: the verified contributor account at reserved id 616, whose nym today
-- is 'stasher' (seeded as 'k00b' by the original migration, renamed via
-- 20260805100000_stasher_contributor -> 'untraceable', then
-- 20260811100000_stasher_nym -> 'stasher').

-- Fresh-install fallback: ensure stasher exists at id 616 even if an earlier
-- migration was skipped (e.g. a clone that never ran it).
INSERT INTO "users" ("id", "name")
VALUES (616, 'stasher')
ON CONFLICT DO NOTHING;

-- Reference the owner by name so the sub insert works whether stasher landed at
-- id 616 or was skipped because a 'stasher' by name already existed elsewhere.
INSERT INTO "Sub" (
  "name", "userId", "postTypes", "rankingType",
  "billingType", "billingCost", "status", "billingStatus"
)
SELECT
  v.name,
  u.id,
  ARRAY['LINK', 'DISCUSSION', 'JOB', 'POLL', 'BOUNTY']::"PostType"[],
  'WOT',
  'ONCE',
  0,
  'ACTIVE',
  'PAID'
FROM (VALUES
  ('crypto'),
  ('bounties'),
  ('memes')
) AS v(name)
CROSS JOIN "users" u
WHERE u.name = 'stasher'
ON CONFLICT (name) DO NOTHING;
