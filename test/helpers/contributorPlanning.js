// Fixed read-boundary fixtures: real selection, scoring, curator rounding and
// allocation run above these rows. No database, signer or wallet is opened.
export const NOW = new Date('2026-10-19T00:00:00Z')
export const CONFIG = {
  curatorBudgetMode: 'ACTIVE',
  curatorBudgetMultBps: 15000,
  curatorBudgetDrawdownWeeks: 13,
  curatorBudgetAvgPeriods: 4,
  curatorTipCapShareBps: 2500,
  curatorBreakerRatioBps: 25000,
  curatorBreakerFloorMedianPeriods: 12,
  curatorBreakerArmPeriods: 4,
  contributorPoolMode: 'ACTIVE',
  contributorShareBps: 1500,
  contributorTopN: 5,
  contributorWinnerCapBps: 4000,
  contributorCombinedCapBps: 2500,
  contributorMinTipPiconeros: 500000000n,
  contributorTrustThreshold: 0.1,
  contributorMinTrustedTippers: 3,
  contributorTipperCapBps: 3334,
  contributorBreadthTarget: 5,
  contributorReciprocityMult: 0.5,
  contributorReciprocityDays: 30,
  contributorCommentBonusBps: 500,
  contributorCommentBonusMax: 8,
  contributorMinAccountAgeDays: 14,
  contributorLengthFloor: 0.6,
  contributorLengthScaleWords: 100,
  contributorLengthCapWords: 1500,
  distributionExcludedCuratorIds: [],
  distributionMinPayoutPiconeros: 1n,
  distributionTopN: 10
}

export function budgetPlan (config = CONFIG) {
  return {
    targetPiconeros: 850_000_000_000n,
    limitPiconeros: 500_000_000_000n,
    appliedCuratorBudgetPiconeros: config.curatorBudgetMode === 'ACTIVE' ? 500_000_000_000n : 200_000_000_000n,
    record: {
      curatorBudgetMode: config.curatorBudgetMode,
      dynamicBudgetPiconeros: 500_000_000_000n,
      tipT4Piconeros: 566_666_666_667n,
      multBps: 8823,
      dynamicBudgetMode: 'DRAWDOWN'
    },
    configErrors: [],
    breaker: null
  }
}

const post = (id, authorId, at) => ({
  id,
  authorId,
  createdAt: new Date(at),
  authorCreatedAt: new Date('2026-01-01'),
  recipientAddress: `addr-${authorId}`,
  title: `post ${id}`,
  text: 'original prose '.repeat(100),
  url: null,
  pollCost: null,
  bountyPiconeros: '0',
  weightedDownVotes: 0,
  disqualified: false,
  turf: 'stasher',
  ownUploads: 0
})

export function planningModels ({ config = CONFIG, winners = true, winnerAuthor = 101, catchUp = false, noWallet = [], selectionError = null, hypotheticalError = null } = {}) {
  const state = { distribution: null, payouts: [], earns: [], transactions: [] }
  const posts = winners ? [post(11, winnerAuthor, '2026-10-07T12:00:00Z')] : []
  if (catchUp) posts.push(post(12, 102, '2026-09-30T12:00:00Z'))
  for (const p of posts) if (noWallet.includes(p.authorId)) p.recipientAddress = null
  const models = {
    $transaction: async (fn, options) => {
      state.transactions.push(options)
      return await fn(models)
    },
    $executeRaw: async strings => {
      if (strings.join('').includes('ROLLBACK TO SAVEPOINT')) state.aborted = false
      return 0
    },
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join('?')
      if (sql.includes('AS "windowEnd"')) return catchUp ? [{ windowEnd: '2026-09-28', periodEnd: new Date('2026-10-05') }] : []
      if (sql.includes('AS "windowStart"')) return []
      if (sql.includes('FROM "Item" i')) {
        if (selectionError) { state.aborted = true; throw selectionError }
        const dates = values.filter(v => v instanceof Date)
        return posts.filter(p => p.createdAt >= dates[0] && p.createdAt < dates[1])
      }
      if (sql.includes('FROM "ObservedTip" t')) {
        return posts.flatMap(p => [201, 202, 203].map(tipperId => ({ postId: p.id, tipperId, piconeros: p.id === 12 ? '100000000000' : '1000000000', trust: 0.5, reciprocal: false })))
      }
      if (sql.includes('SELECT DISTINCT p.id')) return []
      if (sql.includes('WITH reward_proportions')) {
        if (hypotheticalError && state.curatorReads > 0) { state.aborted = true; throw hypotheticalError }
        state.curatorReads = (state.curatorReads ?? 0) + 1
        return [101, 102, 103, 104].map(curatorId => ({ curatorId, total_proportion: 0.25, earns: JSON.stringify([{ type: 'TIP_POST', rank: 1, typeProportion: 0.25 }]) }))
      }
      if (sql.includes('UPDATE "RewardDistribution"')) return [] // lose the sender CAS: ledger assertions only
      throw new Error(`unexpected fixture SQL: ${sql}`)
    },
    platformFeeConfig: { upsert: async () => config, findUnique: async () => config },
    rewardDistribution: {
      findFirst: async ({ where } = {}) => where ? null : { periodEnd: new Date('2026-10-12'), rolledOverPiconeros: 0n },
      findMany: async () => {
        if (state.aborted) throw new Error('transaction aborted: missing savepoint rollback')
        return []
      },
      create: async ({ data }) => (state.distribution = { ...data, id: 1 }),
      findUnique: async () => ({ ...state.distribution, payouts: state.payouts })
    },
    rewardPayout: { createMany: async ({ data }) => { state.payouts.push(...data) } },
    earn: { createMany: async ({ data }) => { state.earns.push(...data) } },
    moneroAccount: { findFirst: async ({ where }) => noWallet.includes(where.ownerUserId) ? null : { address: `addr-${where.ownerUserId}` } },
    user: { findMany: async () => [], findUnique: async () => ({ referrerId: 301 }) },
    rewardsWalletTransaction: { findMany: async () => [] }
  }
  return { models, state }
}
