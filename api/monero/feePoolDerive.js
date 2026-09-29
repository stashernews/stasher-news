// Fee-subaddress pool derivation + auto top-up (spec §5.6, §6.2).
//
// The rewards-wallet fee pool is pre-derived subaddresses (major 1 = posting,
// 2 = territory, 3 = donate, 4 = tip-unwalleted, 5 = boost) stored as
// SubaddressIndex rows and watched via lws.
// Derivation needs the rewards SPEND key, so this module is imported ONLY by
// worker/rewardsWalletObserver.js (auto top-up) and scripts/derive-rewards-fee-subaddresses.js
// (manual CLI) — never by an api/ payIn path. The running app never reads the
// spend key; the worker reads it only to extend a pool that has run low.

import moneroTs from 'monero-ts'
import { resolveSignerNetworkType } from './signerWallet.js'
import { lwsClient } from './lwsClient.js'
import {
  REWARDS_POSTING_MAJOR,
  REWARDS_TERRITORY_MAJOR,
  REWARDS_DONATE_MAJOR,
  REWARDS_TIP_UNWALLETED_MAJOR,
  REWARDS_BOOST_MAJOR
} from './feePool.js'

export const FEE_POOL_TOPUP_THRESHOLD = Number(process.env.FEE_POOL_TOPUP_THRESHOLD) || 100

const MAJOR_BATCH_ENV = {
  [REWARDS_POSTING_MAJOR]: 'POSTING_FEE_POOL_SIZE',
  [REWARDS_TERRITORY_MAJOR]: 'TERRITORY_FEE_POOL_SIZE',
  [REWARDS_DONATE_MAJOR]: 'DONATE_FEE_POOL_SIZE',
  [REWARDS_TIP_UNWALLETED_MAJOR]: 'TIP_UNWALLETED_FEE_POOL_SIZE',
  [REWARDS_BOOST_MAJOR]: 'BOOST_FEE_POOL_SIZE'
}

const DEFAULT_BATCH = {
  [REWARDS_POSTING_MAJOR]: 2000,
  [REWARDS_TERRITORY_MAJOR]: 200,
  [REWARDS_DONATE_MAJOR]: 200,
  [REWARDS_TIP_UNWALLETED_MAJOR]: 200,
  [REWARDS_BOOST_MAJOR]: 200
}

// AVAILABLE/total/maxMinor counts for one MoneroAccount, keyed by major index.
export async function feePoolLevels (models, accountId) {
  const rows = await models.$queryRaw`
    SELECT "majorIndex" AS major,
           COUNT(*) FILTER (WHERE state = 'AVAILABLE')::int AS available,
           COUNT(*)::int AS total,
           COALESCE(MAX("minorIndex"), 0)::int AS "maxMinor"
    FROM "SubaddressIndex"
    WHERE "accountId" = ${accountId}::int
    GROUP BY "majorIndex"`
  const out = {}
  for (const r of rows) out[Number(r.major)] = { available: r.available, total: r.total, maxMinor: r.maxMinor }
  return out
}

function configError (message) {
  const err = new Error(message)
  err.code = 'FEE_POOL_CONFIG'
  return err
}

// Derive subaddresses for one major up to targetMinor (idempotent: existing
// minors are skipped), then register the [1, targetMinor] range with lws so it
// watches the new indices. Returns the number of new rows added. `account` MUST
// include its viewKey relation (lws login needs it).
export async function extendFeePool (models, { account, major, targetMinor }) {
  const address = process.env.PLATFORM_REWARDS_ADDRESS
  const viewKey = process.env.PLATFORM_REWARDS_VIEW_KEY
  const spendKey = process.env.PLATFORM_REWARDS_SPEND_KEY
  if (!address || !viewKey || !spendKey) {
    throw configError('PLATFORM_REWARDS_ADDRESS, PLATFORM_REWARDS_VIEW_KEY, and PLATFORM_REWARDS_SPEND_KEY must be set to extend the fee pool')
  }
  if (!account?.viewKey) throw configError('extendFeePool: account must include its viewKey relation (re-run sndev monero register-rewards-wallet)')

  const networkEnv = (process.env.MONERO_NETWORK || 'stagenet').toLowerCase()
  const net = resolveSignerNetworkType(moneroTs, networkEnv)
  const wallet = await moneroTs.createWalletKeys({
    networkType: net,
    password: 'derive-only',
    proxyToWorker: false,
    primaryAddress: address,
    privateViewKey: viewKey,
    privateSpendKey: spendKey
  })

  const [current] = await models.$queryRaw`
    SELECT COALESCE(MAX("minorIndex"), 0)::int AS max FROM "SubaddressIndex"
    WHERE "accountId" = ${account.id}::int AND "majorIndex" = ${major}::int`
  const start = Number(current?.max ?? 0) + 1

  let added = 0
  for (let minor = start; minor <= targetMinor; minor++) {
    const subAddress = await wallet.getAddress(major, minor)
    await models.subaddressIndex.upsert({
      where: { accountId_majorIndex_minorIndex: { accountId: account.id, majorIndex: major, minorIndex: minor } },
      create: { accountId: account.id, majorIndex: major, minorIndex: minor, address: subAddress, state: 'AVAILABLE' },
      update: {}
    })
    added++
  }

  if (added > 0) {
    await lwsClient.upsertSubaddrs(account, { [String(major)]: [[1, targetMinor]] })
  }
  return added
}

// Full pool derivation for the manual CLI: majors 1 -> POSTING_FEE_POOL_SIZE,
// 2 -> TERRITORY_FEE_POOL_SIZE, 3/4/5 -> their *_FEE_POOL_SIZE envs. Throws if
// the rewards wallet isn't registered.
export async function deriveFeePoolAll (models) {
  const account = await models.moneroAccount.findFirst({ where: { label: 'platform_rewards' }, include: { viewKey: true } })
  if (!account) throw new Error('platform_rewards MoneroAccount not registered yet; run sndev monero register-rewards-wallet first')

  const plans = [
    { major: REWARDS_POSTING_MAJOR, targetMinor: Number(process.env.POSTING_FEE_POOL_SIZE || 2000) },
    { major: REWARDS_TERRITORY_MAJOR, targetMinor: Number(process.env.TERRITORY_FEE_POOL_SIZE || 200) },
    { major: REWARDS_DONATE_MAJOR, targetMinor: Number(process.env.DONATE_FEE_POOL_SIZE || 200) },
    { major: REWARDS_TIP_UNWALLETED_MAJOR, targetMinor: Number(process.env.TIP_UNWALLETED_FEE_POOL_SIZE || 200) },
    { major: REWARDS_BOOST_MAJOR, targetMinor: Number(process.env.BOOST_FEE_POOL_SIZE || 200) }
  ]
  const results = []
  for (const { major, targetMinor } of plans) {
    const added = await extendFeePool(models, { account, major, targetMinor })
    results.push({ major, added })
  }
  return results
}

// Auto top-up: extend EVERY major whose AVAILABLE count is below `threshold`
// by one batch (batch size = the major's POSTING/TERRITORY_FEE_POOL_SIZE env).
// `account` and `derive` are injectable for tests; the defaults resolve the
// real platform_rewards wallet and call extendFeePool. A module-level flag
// prevents overlapping derivations (e.g. two rewardsWalletObserver polls racing).
let topUpInProgress = false
let configWarned = false

export async function topUpFeePoolIfLow (models, { threshold = FEE_POOL_TOPUP_THRESHOLD, account, derive } = {}) {
  if (topUpInProgress) return { topUps: [], skipped: 'in-progress' }
  topUpInProgress = true
  try {
    if (!account) {
      account = await models.moneroAccount.findFirst({
        where: { label: 'platform_rewards', network: (process.env.MONERO_NETWORK || 'stagenet').toUpperCase() },
        include: { viewKey: true }
      })
    }
    if (!account) return { topUps: [], skipped: 'no-account' }

    const doDerive = derive || (async opts => extendFeePool(models, opts))
    const levels = await feePoolLevels(models, account.id)
    const topUps = []
    for (const major of [REWARDS_POSTING_MAJOR, REWARDS_TERRITORY_MAJOR, REWARDS_DONATE_MAJOR, REWARDS_TIP_UNWALLETED_MAJOR, REWARDS_BOOST_MAJOR]) {
      const available = levels[major]?.available ?? 0
      if (available >= threshold) continue
      const maxMinor = levels[major]?.maxMinor ?? 0
      const batch = Number(process.env[MAJOR_BATCH_ENV[major]] || DEFAULT_BATCH[major])
      const targetMinor = maxMinor + batch
      try {
        const added = await doDerive({ account, major, targetMinor })
        topUps.push({ major, targetMinor, added })
        console.log('fee-pool auto top-up: major=' + major + ' extended to minor ' + targetMinor + ' (added ' + added + ')')
      } catch (err) {
        if (err?.code === 'FEE_POOL_CONFIG') {
          // Spend key not available in this process: top-up is disabled, warn once.
          if (!configWarned) {
            console.error('fee-pool auto top-up disabled:', err.message)
            configWarned = true
          }
          continue
        }
        throw err
      }
    }
    return { topUps }
  } finally {
    topUpInProgress = false
  }
}
