# Quest rebalance + boost credit — production rollout runbook

Date: 2026-10-06
Branch: `quest-boost-credit` — tip at time of writing: `1246a6db` (`1246a6db161ad871579501e056d5b73d7064223b`)
Source spec: `~/Stasher-local/ops-docs/specs/2026-10-05-quest-rebalance-boost-credit.md`

Housekeeping: `docs/ops/` is gitignored (`.gitignore:35`); this runbook is
force-added there as its first tracked file, so the convention break stays
discoverable from the repo alone.

This doc is the deployment handoff for the quest-rebalance + BOOST credit feature
(flat quest reply rewards, 10-reply banking cap, day-5 boost credit with exact-ID
redemption, promo-only ranking term). Everything in "Production rollout" below is a
**future, separately authorized ops action** — none of it was executed while building
the feature, and nothing in the FAQ database was touched during development (the
tracked `docs/user/faq.md` is seeded to the DB by the deploy step, which is one of
those authorized ops).

## What changed

- **Flat quest rewards:** every completed daily quest banks one free reply credit
  (was: upvote 1, first responder / post-or-comment 2). Clearing both quests still
  advances the flame.
- **10-reply banking cap:** new grants pause while 10 or more unexpired, unused reply
  credits are held; suppressed grants are not saved for later. Existing balances above
  10 are kept in full. Post cap is unchanged (5). One-month expiry and base-allowance-
  first spending are unchanged.
- **BOOST reward type:** `StreakRewardType` gains `BOOST` (migration
  `20261005222538_boost_credit_reward_type`, `ALTER TYPE ... ADD VALUE 'BOOST'`).
  The boost rung — day 5 on odd flame weeks, day 2 on even weeks (2026-10-06
  week-parity ladder) — grants one boost credit if none is held; it expires
  exactly 30 days after grant and a later boost-credit reward does not refresh it.
  `BOOST_CREDIT_PICONEROS = 500,000,000n` (0.5 mXMR ranking weight) in `lib/quests.js`.
- **Promo ranking storage:** `Item.promoBoostPiconeros BIGINT NOT NULL DEFAULT 0`
  plus a renewed `item_ranking_trigger` that folds the promo term into `ranktop` /
  `ranklit` and the decayed `litCenteredSum` with exactly the same weight as a paid
  boost (migration `20261005222631_boost_credit_ranking`). The trigger's UPDATE OF
  column list was extended so promo writes fire it (and the search `indexItem` job).
  No historical backfill; and per the migration header, nothing in the payIn engine,
  `item_net_investment`, or the reward ledger reads the column — it is NOT money.
- **Exact-ID redemption:** mutation `useBoostCredit(itemId: ID!, rewardId: ID!): Item!`
  (`api/typeDefs/item.js`, resolver `api/resolvers/boost-credit.js`) consumes the
  caller's own unexpired BOOST reward on one of their own live posts inside a
  `Serializable` transaction: one consumed receipt, `promoBoostPiconeros` incremented
  by `BOOST_CREDIT_PICONEROS`. Exact-ID means exactly that: the reward must belong to
  the caller and be unexpired, so a passed-through id can never redeem someone
  else's credit.
- **GraphQL surface:** `Privates.boostCreditId` / `Privates.boostCreditExpiresAt`
  (`api/typeDefs/user.js`); the mutation returns a path-aware Item, not a PayIn.
- **UX:** boost modal offers the credit separately from the paid form, with an
  absolute expiry readout, a copy/disclaimer block ("promotional ranking only; no XMR
  payment and no rewards-pool contribution"), a dead-endpoint retry box that re-uses
  the captured original `rewardId` after an unknown-outcome failure, and an
  expiry-driven disable; `ItemDetails` shows a separate non-zero-only "promo boost"
  row, deliberately left out of the stashed/invested/comment money totals.

## Production rollout (authorized ops; not yet executed)

```bash
export NODE_ENV=production
DC="docker compose --env-file .env.development --env-file .env.local -f docker-compose.yml -f docker-compose.volumes.yml -f docker-compose.override.yml -f docker-compose.prodmode.yml"
```

Snapshot according to `~/Stasher-local/ops-docs/runbooks/migrations.md` (verify the
backup, not only the command exit), stop app/worker, deploy the authorized release,
then migrate before the production build:

```bash
$DC stop app worker
$DC run --rm --no-deps --entrypoint /etc/stashernews/scripts/load-secrets-local.sh app sh -c 'npx prisma generate && npx prisma migrate deploy && npm run build'
$DC up -d app worker
$DC restart app worker
$DC run --rm --no-deps -e SN_DOCS_AUTHOR_ID=616 --entrypoint /etc/stashernews/scripts/load-secrets-local.sh app npx tsx --tsconfig jsconfig.json scripts/deploy_user_documentation.js
$DC ps
```

The migrations that will deploy (exact directories on `master`):

- `prisma/migrations/20261005222538_boost_credit_reward_type`
- `prisma/migrations/20261005222631_boost_credit_ranking`
- `prisma/migrations/20261006060000_lit_boost_tip_parity`

All three are additive. The first two add the enum value + column and rewrite the
ranking trigger for the promo term; the third rescales the hot-feed (`lit`)
boost terms to tip parity (`/1000.0` — 1 mXMR of boost then equals 1 mXMR of
tips in hot weight, matching ranktop and the FAQ's 1:1 promise) without any
backfill. Historical hot-ranking weights are explicitly grandfathered for this
release. Decay and recentering preserve the centered-log sort key, so old boost
contributions retain their inflated coefficient; they do not self-correct within
a day or merely on the next rank update. A boost-only 1000x coefficient adds
`ln(1000)` to a positive sort key (about 39.9 hours of additional freshness at
the 4h half-life). Mixed historic sums must not be divided wholesale by 1000:
that would incorrectly rescale tips and costs too. Any historical correction
requires a separately approved reconstruction design; this migration fixes only
new boost deltas and does not rewrite past weight.
Note the AGENTS.md restart-pair rule: app AND worker must restart after
migrations (cached plan / stale Prisma client failure modes).

Do not print secrets or use bare production `docker exec` for the FAQ. After restart,
probe DMMF (schema only, no secrets):

```bash
docker exec app node -e "const {Prisma}=require('@prisma/client');console.log(Prisma.dmmf.datamodel.models.find(m=>m.name==='Item').fields.map(f=>f.name));console.log(Prisma.dmmf.datamodel.enums.find(e=>e.name==='StreakRewardType'))"
```

Expect `promoBoostPiconeros` in the Item fields and `BOOST` in `StreakRewardType`.

Post-deploy checks: `/faq` renders the updated passages (the last command above is
what seeds them), homepage, profile, an item with a promo weight shows the separate
"promo boost" row, the boost modal shows the credit offer only while an unexpired
credit is held (and the paid form still works), and `/rewards` transparency agrees
with the DB ledger. Use an authorized existing-credit test only; do not grant credits
to real users by raw SQL or pay real boosts solely to validate the deployment.
Observe pool/transparency for unchanged ledger facts (no new PayIn / observation rows
from a promo redemption), not for a globally constant value — ordinary user activity moves the pool meanwhile.

## Verification performed on dev (2026-10-06)

Environment: dev docker stack (db/app/worker up, `next dev`, seeded DB),
`RUN_STAGENET_INTEGRATION` unset (= 0), worktree `quest-boost-credit` @ `1246a6db`.
Jest runs non-TTY via `docker exec -i -w /app -u apprunner app npm run test -- <files>`.

Combined suite 1 — quests / granting / ranking:

```text
npm run test -- test/lib/quests.test.js test/worker/quests.test.js \
  test/worker/quests.streak.test.js test/api/quests/boost-credit.test.js \
  test/api/resolvers/boost-credit.test.js test/prisma/boost-credit-ranking.test.js
Test Suites: 6 passed, 6 total
Tests:       116 passed, 116 total
Time:        3.239 s
```

Combined suite 2 — payIn boost isolation / fee routing / rewards ledger:

```text
npm run test -- test/api/payIn/boost.test.js test/worker/rewardsWalletObserver.fee.test.js \
  test/api/monero/turfFeeRouting.boost.test.js test/api/monero/rewardsInflow.test.js \
  test/api/monero/rewardsLedger.test.js
Test Suites: 5 passed, 5 total
Tests:       6 skipped, 78 passed, 84 total
Time:        1.447 s
```

(the 6 skipped are the pre-existing `ISOLATED_DB ? describe : describe.skip` gates in
`test/api/monero/rewardsInflow.test.js` / `rewardsLedger.test.js`, not regressions)

Full suite (`npm run test`, serial `maxWorkers: 1`, dev DB):
```text
Test Suites: 2 failed, 4 skipped, 216 passed, 218 of 222 total
Tests:       3 failed, 125 skipped, 2621 passed, 2749 total
Time:        56.904 s
```
(suite #2 recorded after the drift bite below; the same run at #1 was
`3 failed / 9 failed tests / 2615 passed` before the DB restore.)
The 4 skipped suites are the integration/load gates
(`test/integration/*`, `test/load/*`); the 125 skipped individual tests are their
gated content plus the `ISOLATED_DB ? describe : describe.skip` blocks. The full run
also collects the untracked `test/local/boost-credit-modal.test.js` — local-only per
the no-commit hygiene rule, PASS (21 tests) in both full runs.

Full-suite failures, triaged:

1. **`test/lib/apiKeyGuard.test.js` — 1 failure (feature gap).** The guard requires
   every new Mutation to be classified. The branch's `useBoostCredit` is in neither
   list: `Expected [] → Received ["useBoostCredit"]` at `test/lib/apiKeyGuard.test.js:74`.
   Fix is a one-line addition of `'useBoostCredit'` to `API_KEY_BLOCKED_MUTATIONS`
   (`lib/apiKeyGuard.js`) — a spendable, value-bearing single-use credit
   redemption belongs to the blocked money class (same rationale as
   `initiateTip`/`payBounty`), not to the reviewed-non-sensitive content class.
   **CLOSED** by follow-up commit `f6c1faf7` ("fix(rewards): block boost-credit
   redemption via api key", one commit after this doc's `f1c42386`): one-line
   addition of `'useBoostCredit'` to `API_KEY_BLOCKED_MUTATIONS` in
   `lib/apiKeyGuard.js`; covering suites `test/lib/apiKeyGuard.test.js` +
   `test/api/resolvers/boost-credit.test.js` pass 68/68. The pre-fix numbers
   above are retained as observed at `1246a6db`.
2. **`test/components/bounty-actions.test.js` — 2 failures (pre-existing on
   master, unrelated to the branch).** Both render an element type of
   `undefined`: the test imports `AwardBountyDropdownItem` from
   `@/components/bounty-actions`, but that symbol no longer exists anywhere —
   commit `7324a331` (2026-10-01, "inline award-bounty button … replaces the
   three-dots menu item", an ancestor of this branch) replaced the dropdown
   entry with the inline button (`components/award-bounty.js`) and the test was
   never updated. The test file and component are byte-identical between
   master and this branch, so the failure predates the branch's work. Needs its
   own fix (point the test at `components/award-bounty.js`'s inline button or
   retire it); out of scope here.
3. **`test/worker/rewardsDistributor.test.js` — 6 failures in the first runs,
   0 after repair (dev-DB config drift, not the branch).** The suite pins
   allocation constants against the migration-canonical `PlatformFeeConfig`
   values; the dev DB's id=1 row had drifted:
   `downvoteRewardsPct 70 (canonical 100)`, `postingFeeRewardsPct 30
   (canonical 70)`, `territoryFeeRewardsPct 100 (canonical 30)`,
   `walletlessTipRewardsPct 30 (canonical 70, migration
   20260816000000 explicitly pins 70)`, `distributionTopN 25 (canonical 10,
   migration 20260819000000)`. The observed deficits match the drift exactly:
   first run −2.5e12 piconeros, after restoring downvote/territory/walletless
   −0.9e12 more resolved → 15.5e12 actual vs 17.1e12 expected with the final
   −1.6e12 being exactly `posting 4e12 × (70−30)%`. Repaired with the
   migration-canonical row values and nothing else:
   ```sql
   UPDATE "PlatformFeeConfig" SET
     "downvoteRewardsPct" = 100, "postingFeeRewardsPct" = 70,
     "territoryFeeRewardsPct" = 30, "walletlessTipRewardsPct" = 70
   WHERE id = 1;
   ```
   After repair: `Test Suites: 1 passed; Tests: 18 skipped, 44 passed, 62 total`.
   Not repaired (recorded, suite-neutral, left for the operator):
   `distributionTopN` 25 vs migration-pinned 10, `territoryMonthlyPiconeros`
   30e9 vs migration-pinned 20e9, territory yearly/once likewise. The dev app's
   displayed turf pricing reflects the drifted values, so an operator chose
   them or the row predates the migrations — either way, restoring those is an
   operator decision, not part of this rollout.
   Origin of drift: none of the branch's commits touches
   `PlatformFeeConfig`, the distributor, the inflow reader, or the payIn engine
   (`git diff 380cf746..HEAD` scope confirmed); something edited the row
   operator-side outside this feature.

Rerun effect: after the repair, rerunning the same suite shows the previously failing
pool assertions green; no test edits were involved.

Lint (`npm run lint` → standard): exit 1 with exactly four errors, all in the
pre-existing `test/api/item-monero-wall.test.js`:

```text
test/api/item-monero-wall.test.js:2:10: 'randomUUID' is defined but never used. (no-unused-vars)
test/api/item-monero-wall.test.js:3:10: 'PrismaClient' is defined but never used. (no-unused-vars)
test/api/item-monero-wall.test.js:4:21: 'updateItem' is defined but never used. (no-unused-vars)
test/api/item-monero-wall.test.js:5:10: 'createMoneroWallLoader' is defined but never used. (no-unused-vars)
```

Residue cleanup (`./scripts/clean-rewards-test-residue.sh` on the host, run after the
suites and again after the repair reruns — idempotent per AGENTS.md):

```text
DELETE 0 (×7 tables)
DELETE 4
DELETE 5
=== rewards-test residue cleanup complete ===
```

(0 rows on the journal/users tables; the 4/5-row deletes are the test-pattern
observation fixtures with the script's `rdfee`/`rdtip`/`rddv`/`cs`/`cf` txHash
prefixes left by earlier real-DB suites. Safe by construction per the script
header: it only deletes test-identifiable rows — test prefixes, fake-sent
payouts, empty-name users, the `makeAddress` signature — never real activity or
real distributions.)

**Pre-existing master lint failure:** `test/api/item-monero-wall.test.js` fails on
master with the same 4 no-unused-errors — it is untouched by this branch and is not a
regression from it.

GraphQL schema probes (dev app on :3000; `me`/`item` themselves resolve null without a
session/missing item — the probes only assert the fields exist in the published
schema):

```text
$ curl -s http://localhost:3000/api/graphql -H 'content-type: application/json' \
  -d '{"query":"{ me { privates { boostCreditId } } }"}'
{"data":{"me":null}}

$ curl -s http://localhost:3000/api/graphql -H 'content-type: application/json' \
  -d '{"query":"{ item(id: 1) { promoBoostPiconeros } }"}'
{"data":{"item":null}}
```

No `UNKNOWN_FIELD` / `VALIDATION_ERROR` in either response — `Privates.boostCreditId`
and `Item.promoBoostPiconeros` are published. `useBoostCredit` is mounted via the
same typeDefs (`api/typeDefs/item.js`).

## Human spot-check TODO before merge

- [ ] Boost modal smoke, desktop and mobile: credit offer appears only with a held
      unexpired credit, absolute expiry readout, redeem succeeds on own live post,
      paid boost path unaffected.
- [ ] Dead-endpoint retry box: kill the fetch during redeem (unknown outcome) →
      retry button replaces the offer, re-uses the captured original `rewardId`, and
      re-enable of new/paid submissions after retry or modal close.
- [ ] Note-prop disclaimer visible on the credit success view: "promotional ranking
      only; no XMR payment and no rewards-pool contribution" (never a "payment
      detected" claim).
- [ ] `_prop`/note disclaimers rendering where expected (item details "promo boost"
      row separate from money totals).
- [ ] Updated FAQ rendered at `/faq` after a dev docs deploy (DB deploy was excluded
      from this documentation session; `./scripts/deploy_user_documentation.js` is the
      normal dev step).
- [ ] Synthetic-account accounting: on a dev synthetic account, one credit redeem ->
      exactly one consumed BOOST receipt, `promoBoostPiconeros` += 500,000,000 on the
      redeemed own post, zero PayIn/observation changes, paid `boost` and
      netInvestment unchanged; first-responder quest +1 credit observed; holding 12
      banked replies → no new rows granted; a fresh completion at 9 returns 10.
- [ ] Rewards-display residue check after any suite run:
      `./scripts/clean-rewards-test-residue.sh` (idempotent; deletes only
      test-pattern rows). Output tails are recorded in the verification section
      above.

## Rollback story

Additive schema, trigger rewrite, and receipts stay. The rollback is a forward patch
that disables new BOOST grants and redemptions while preserving issued credit data —
no `DROP` of the enum value or column, no rank subtraction, no automatic
compensation, and no arbitrary rollback to an old image. Enum-value removal is
unsafe-ish for `ALTER TYPE ... ADD VALUE` to a subscripted type; leave the value in
place. The promo term only participates through `Item.promoBoostPiconeros` and the
ranking trigger, so a redaction (set to 0) would be visibly traceable in history and
accepts no accidental `netInvestment` drift.
