import { allocateInflow, money } from '@/lib/rewardsAccounting'

// The single CONFIRMED rewards-hot-wallet inflow reader (rewards accounting
// repair §5). Every consumer — the next-pool readout, the weekly distributor,
// the transparency pages, the ops sweep bound and the repair manifest — reads
// inflow from here so their windows, eligibility and exact splits can never
// drift apart.
//
// Rules:
//   - A receipt counts only with `walletReceipt = true` AND `state = CONFIRMED`
//     in the half-open window `[start, end)` on confirmedAt. Funding-time
//     BOUNTY_FEE rows and zero-fee abandonment pseudo-rows are historical
//     evidence, never cash.
//   - `end = null` means no upper bound; `start = new Date(0)` is the all-time
//     source reader.
//   - DONATE rows floor each row's payer-chosen percentage independently (a
//     numeric-wide multiply truncated per row before summation, so a large
//     receipt cannot overflow a bigint intermediate), so `raw.donate` is the
//     reward-scaled total and `raw.donateRaw` the unscaled one; they stay
//     distinct.
//   - A mixed bounty rollover row stores the net receipt in `piconeros` and its
//     exact rewards component in `rewardsPiconeros`; the SQL COALESCE falls back
//     to the full legacy rollover amount per row when the component is NULL.
//   - All values are bound parameters (Prisma tagged template), never
//     interpolated SQL strings.

const amount = value => (value == null ? 0n : money(value))

export async function readRewardsInflow (models, { start, end = null, config } = {}) {
  const [row] = await models.$queryRaw`
    SELECT
      COALESCE((SELECT sum("piconeros") FROM "ObservedDownvote"
        WHERE state = 'CONFIRMED' AND "confirmedAt" >= ${start}
        AND (${end}::timestamp IS NULL OR "confirmedAt" < ${end}::timestamp)), 0)::bigint AS downvote,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation"
        WHERE "feeType" = 'POSTING' AND "walletReceipt" = true AND state = 'CONFIRMED'
        AND "confirmedAt" >= ${start} AND (${end}::timestamp IS NULL OR "confirmedAt" < ${end}::timestamp)), 0)::bigint AS posting,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation"
        WHERE "feeType" IN ('TERRITORY_CREATE','TERRITORY_BILLING','TERRITORY_UNARCHIVE','TERRITORY_UPDATE')
        AND "walletReceipt" = true AND state = 'CONFIRMED'
        AND "confirmedAt" >= ${start} AND (${end}::timestamp IS NULL OR "confirmedAt" < ${end}::timestamp)), 0)::bigint AS territory,
      COALESCE((SELECT sum(trunc("piconeros"::numeric * COALESCE("donationRewardsPct", 100) / 100)) FROM "FeeObservation"
        WHERE "feeType" = 'DONATE' AND "walletReceipt" = true AND state = 'CONFIRMED'
        AND "confirmedAt" >= ${start} AND (${end}::timestamp IS NULL OR "confirmedAt" < ${end}::timestamp)), 0)::bigint AS donate,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation"
        WHERE "feeType" = 'DONATE' AND "walletReceipt" = true AND state = 'CONFIRMED'
        AND "confirmedAt" >= ${start} AND (${end}::timestamp IS NULL OR "confirmedAt" < ${end}::timestamp)), 0)::bigint AS "donateRaw",
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation"
        WHERE "feeType" = 'BOOST' AND "walletReceipt" = true AND state = 'CONFIRMED'
        AND "confirmedAt" >= ${start} AND (${end}::timestamp IS NULL OR "confirmedAt" < ${end}::timestamp)), 0)::bigint AS boost,
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation"
        WHERE "feeType" = 'TIP_UNWALLETED' AND "walletReceipt" = true AND state = 'CONFIRMED'
        AND "confirmedAt" >= ${start} AND (${end}::timestamp IS NULL OR "confirmedAt" < ${end}::timestamp)), 0)::bigint AS walletlesstip,
      COALESCE((SELECT sum(piconeros) FROM "FeeObservation"
        WHERE "feeType" = 'BOUNTY_ROLLOVER' AND "walletReceipt" = true
        AND state = 'CONFIRMED' AND "confirmedAt" >= ${start}
        AND (${end}::timestamp IS NULL OR "confirmedAt" < ${end}::timestamp)), 0)::bigint AS bountyrollover,
      COALESCE((SELECT sum(COALESCE("rewardsPiconeros", piconeros)) FROM "FeeObservation"
        WHERE "feeType" = 'BOUNTY_ROLLOVER' AND "walletReceipt" = true
        AND state = 'CONFIRMED' AND "confirmedAt" >= ${start}
        AND (${end}::timestamp IS NULL OR "confirmedAt" < ${end}::timestamp)), 0)::bigint AS "bountyrolloverRewards",
      COALESCE((SELECT sum("piconeros") FROM "FeeObservation"
        WHERE "feeType" = 'BOUNTY_FEE' AND "walletReceipt" = true AND state = 'CONFIRMED'
        AND "confirmedAt" >= ${start} AND (${end}::timestamp IS NULL OR "confirmedAt" < ${end}::timestamp)), 0)::bigint AS bountyfee,
      (date_trunc('week', now() AT TIME ZONE 'UTC') + interval '1 week') AT TIME ZONE 'UTC' AS time`

  const raw = {
    downvote: amount(row.downvote),
    posting: amount(row.posting),
    territory: amount(row.territory),
    donate: amount(row.donate),
    donateRaw: amount(row.donateRaw),
    boost: amount(row.boost),
    walletlesstip: amount(row.walletlesstip),
    bountyrollover: amount(row.bountyrollover),
    // NULL means "no exact split supplied" (legacy rows are already COALESCEd
    // per row in SQL); preserve it so allocateInflow keeps the legacy rule.
    bountyrolloverRewards: row.bountyrolloverRewards == null ? null : amount(row.bountyrolloverRewards),
    bountyfee: amount(row.bountyfee),
    time: row.time
  }
  const { totalPiconeros, rewardsPiconeros, opsPiconeros, sources } = allocateInflow(raw, config)
  return { raw, totalPiconeros, rewardsPiconeros, opsPiconeros, sources }
}
