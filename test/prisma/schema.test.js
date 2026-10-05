/* eslint-env jest */

// Schema-presence test for the StasherNews baseline (Task 1).
// Inspects the *generated* Prisma client DMMF metadata, so it only requires
// `prisma generate` — no live database connection is made.
//
// Run via: ./sndev test test/prisma/schema.test.js

import { Prisma } from '@prisma/client'

// Prisma.dmmf is the documented, stable DMMF accessor (the instance-level
// `prisma._dmmf` used in the brief is internal and not exposed in 5.x).
const allModels = Prisma.dmmf.datamodel.models
const allEnums = Prisma.dmmf.datamodel.enums
const modelNames = allModels.map(m => m.name)

const fieldsOf = (modelName) =>
  allModels.find(m => m.name === modelName)?.fields.map(f => f.name) ?? []
const valuesOf = (enumName) =>
  allEnums.find(e => e.name === enumName)?.values.map(v => v.name) ?? []

const EXPECTED_MODELS = [
  'MoneroAccount',
  'MoneroViewKey',
  'SubaddressIndex',
  'ObservedTip',
  'ObservedDownvote',
  'RewardDistribution',
  'RewardPayout',
  'DownvotePidMap',
  'PlatformFeeConfig',
  'ObservedBounty',
  'BountyPidMap',
  'BountyPayment',
  'AuthChallenge',
  'StreakReward',
  'QuestCompletion'
]

const REMOVED_MODELS = [
  'PayInBolt11',
  'PayOutBolt11',
  'PayInCustodialToken',
  'PayOutCustodialToken',
  'RefundCustodialToken',
  'SubPayOutCustodialToken',
  'PessimisticEnv',
  'LnAuth',
  'Wallet',
  'WalletProtocol',
  'WalletTemplate',
  'WalletLog',
  'Vault',
  'ItemForward'
]

test('stasher schema has the Monero observation models', () => {
  for (const m of EXPECTED_MODELS) {
    expect(modelNames).toContain(m)
  }
})

test('stasher schema has no custodial/Lightning residue models', () => {
  for (const removed of REMOVED_MODELS) {
    expect(modelNames).not.toContain(removed)
  }
})

test('Item keeps the ranking-trigger column names verbatim', () => {
  const fields = fieldsOf('Item')
  // These identifiers are referenced verbatim by item_ranking_trigger() SQL
  // (migration 20260803205000_rebrand_piconeros). Units are piconeros; names
  // must match the rewritten trigger or it breaks.
  for (const c of [
    'piconeros', 'downPiconeros', 'boost', 'cost',
    'commentPiconeros', 'commentCost', 'commentBoost', 'commentDownPiconeros',
    'ranktop', 'litCenteredSum', 'litCenteredAt', 'ranklit'
  ]) {
    expect(fields).toContain(c)
  }
})

test('Item has the StasherNews posting-fee columns (subaddress columns dropped)', () => {
  const fields = fieldsOf('Item')
  for (const c of ['feeStatus', 'feePayInId', 'feePayIn', 'observedTips', 'observedDownvotes']) {
    expect(fields).toContain(c)
  }
  // dead pre-registered-subaddress columns and relation removed in Task 5
  for (const removed of ['subaddressIndexMajor', 'subaddressIndexMinor', 'subaddress', 'moneroAccountId', 'moneroAccount', 'subaddresses']) {
    expect(fields).not.toContain(removed)
  }
})

// Regression guard: the `moneroAccount` back-relation was dropped from Item
// along with the scalar `moneroAccountId` (Task 5), so it is asserted absent.
// The surviving Monero back-relations are asserted via DMMF `kind` as relation
// fields, so a dropped/renamed relation is caught going forward.
const relationFieldsOf = (modelName) => {
  const model = allModels.find(m => m.name === modelName)
  return new Set(model ? model.fields.filter(f => f.kind === 'object').map(f => f.name) : [])
}

test('Item exposes its Monero back-relations as relation fields', () => {
  const rels = relationFieldsOf('Item')
  for (const r of ['observedTips', 'observedDownvotes']) {
    expect(rels).toContain(r)
  }
  // PostSubaddress back-relation removed in Task 5
  for (const removed of ['moneroAccount', 'subaddresses']) {
    expect(rels).not.toContain(removed)
  }
})

test('MoneroAccount drops the Item.posts inverse relation', () => {
  const rels = relationFieldsOf('MoneroAccount')
  expect(rels).not.toContain('posts')
})

test('User has the StasherNews Monero fields and no custodial balance fields', () => {
  const fields = fieldsOf('User')
  for (const c of ['moneroAddress', 'privacyMode', 'stackedPiconeros', 'downvotePiconeros', 'tipDefaultPiconeros', 'moneroAccounts', 'rewardPayouts', 'hideStashAmount']) {
    expect(fields).toContain(c)
  }
  // stackedMsats dropped (stackedPiconeros survives) and stackedMcredits renamed
  // to stackedCredits.
  for (const removed of ['stackedMsats', 'stackedMcredits', 'vaultKeyHash', 'hasSendWallet', 'hasRecvWallet', 'autoWithdrawThreshold', 'noteDeposits', 'noteWithdrawals', 'hideUriDesc', 'tipUndos', 'turboTipping']) {
    expect(fields).not.toContain(removed)
  }
})

test('PayInType and PayInState enums are reduced to the StasherNews set', () => {
  expect(valuesOf('PayInType').sort()).toEqual([
    'BOOST', 'DONATE', 'DOWNVOTE', 'ITEM_CREATE', 'ITEM_UPDATE',
    'MEDIA_UPLOAD', 'POLL_VOTE', 'TERRITORY_BILLING', 'TERRITORY_CREATE',
    'TERRITORY_UNARCHIVE', 'TERRITORY_UPDATE', 'TIP'
  ])
  // PAID is restored for the SN payIn engine (piconeros=0 / completed actions use
  // payInState='PAID'); it was a Phase 0 reconciliation gap to drop it.
  expect(valuesOf('PayInState').sort()).toEqual(['CONFIRMED', 'DETECTED', 'FAILED', 'PAID', 'PENDING_PAYMENT'])
})

test('Item netInvestment and feeInvestmentPiconeros are BigInt (piconero scale)', () => {
  const model = allModels.find(m => m.name === 'Item')
  for (const name of ['netInvestment', 'feeInvestmentPiconeros']) {
    const f = model.fields.find(field => field.name === name)
    expect(f).toBeTruthy()
    expect(f.type).toBe('BigInt')
  }
})

test('User and Sub filter fields are BigInt piconero filters', () => {
  const check = (modelName, names) => {
    const model = allModels.find(m => m.name === modelName)
    for (const name of names) {
      const f = model.fields.find(field => field.name === name)
      expect(f).toBeTruthy()
      expect(f.type).toBe('BigInt')
    }
  }
  check('User', ['postsPiconerosFilter', 'commentsPiconerosFilter'])
  check('Sub', ['postsPiconerosFilter'])
  // Pin the defaults: User filters default to -0.025 XMR (-25000000000
  // piconeros), Sub turf filter defaults to -0.1 XMR (-100000000000
  // piconeros). A future schema edit must not silently change or drop
  // either default.
  const userModel = allModels.find(m => m.name === 'User')
  for (const name of ['postsPiconerosFilter', 'commentsPiconerosFilter']) {
    const f = userModel.fields.find(field => field.name === name)
    expect(f.default).toBe('-25000000000')
  }
  const subModel = allModels.find(m => m.name === 'Sub')
  const subField = subModel.fields.find(field => field.name === 'postsPiconerosFilter')
  expect(subField.default).toBe('-100000000000')
})

test('User has no forward-notification setting residue', () => {
  expect(fieldsOf('User')).not.toContain('noteForwardedPiconeros')
})

test('StreakType enum drops the legacy coin value (FLAME, VERIFIED)', () => {
  expect(valuesOf('StreakType').sort()).toEqual(['FLAME', 'VERIFIED'])
})

test('Streak defaults its type to FLAME', () => {
  const typeField = allModels.find(m => m.name === 'Streak')?.fields.find(f => f.name === 'type')
  expect(typeField).toBeTruthy()
  expect(typeField.type).toBe('StreakType')
  expect(typeField.default).toBe('FLAME')
})

test('User has no gun/horse streak columns', () => {
  const fields = fieldsOf('User')
  for (const c of ['gunStreak', 'horseStreak']) {
    expect(fields).not.toContain(c)
  }
})

test('User badge settings use the re-themed names (hideBadges/noteBadges)', () => {
  const fields = fieldsOf('User')
  for (const c of ['hideBadges', 'noteBadges']) {
    expect(fields).toContain(c)
  }
  // cowboy-era names removed by the 20260808105600_badge_settings_rename migration
  for (const c of ['hideCowboyHat', 'noteCowboyHat']) {
    expect(fields).not.toContain(c)
  }
})

test('Item has the A-13 bounty lifecycle columns and relations', () => {
  const fields = fieldsOf('Item')
  for (const c of ['bountyPiconeros', 'bountyStatus', 'bountyConfirmedAt', 'bountyPayments', 'observedBounties']) {
    expect(fields).toContain(c)
  }
  const piconeros = allModels.find(m => m.name === 'Item').fields.find(f => f.name === 'bountyPiconeros')
  expect(piconeros.type).toBe('BigInt')
  expect(piconeros.default).toBe('0')
  const status = allModels.find(m => m.name === 'Item').fields.find(f => f.name === 'bountyStatus')
  expect(status.type).toBe('BountyStatus')
  expect(status.default).toBe('UNFUNDED')
})

test('A-13 bounty enums and PostType.BOUNTY are in the DMMF', () => {
  expect(valuesOf('PostType')).toContain('BOUNTY')
  expect(valuesOf('BountyStatus').sort()).toEqual([
    'AWARDED', 'DETECTED', 'EXPIRED', 'FUNDED', 'PENDING_FUNDING',
    'REFUNDED', 'ROLLED_OVER', 'UNFUNDED'
  ])
  expect(valuesOf('BountyPayoutState').sort()).toEqual(['CONFIRMED', 'FAILED', 'QUEUED', 'SENT'])
  expect(valuesOf('BountyPayoutKind').sort()).toEqual(['AWARD', 'RECLAIM', 'ROLLOVER'])
  for (const v of ['BOUNTY_FEE', 'BOUNTY_ROLLOVER']) {
    expect(valuesOf('FeeType')).toContain(v)
  }
})

test('PlatformFeeConfig has the A-13 bounty fee fields', () => {
  const fields = allModels.find(m => m.name === 'PlatformFeeConfig').fields
  const byName = Object.fromEntries(fields.map(f => [f.name, f]))
  expect(byName.bountyFeeMinPiconeros.type).toBe('BigInt')
  expect(byName.bountyFeeMinPiconeros.default).toBe('10000000000')
  expect(byName.bountyFeePct.type).toBe('Int')
  expect(byName.bountyFeePct.default).toBe(1)
  expect(byName.bountyExpiryDays.type).toBe('Int')
  expect(byName.bountyExpiryDays.default).toBe(30)
})

test('PlatformFeeConfig has the commentFeePiconeros knob', () => {
  const fields = allModels.find(m => m.name === 'PlatformFeeConfig').fields
  const byName = Object.fromEntries(fields.map(f => [f.name, f]))
  expect(byName.commentFeePiconeros.type).toBe('BigInt')
  expect(byName.commentFeePiconeros.default).toBe('600000000')
})

test('User and AuthChallenge have the recovery-phrase auth fields', () => {
  const userFields = fieldsOf('User')
  expect(userFields).toContain('phrasePubkey')
  const fields = fieldsOf('AuthChallenge')
  for (const c of ['id', 'createdAt', 'k1', 'pubkey']) {
    expect(fields).toContain(c)
  }
  // k1 is a fixed-width 64-char hex column (32 bytes)
  const k1 = allModels.find(m => m.name === 'AuthChallenge').fields.find(f => f.name === 'k1')
  expect(k1.type).toBe('String')
})

test('Item has the turf-repost home-turf field', () => {
  const fields = allModels.find(m => m.name === 'Item').fields
  const byName = Object.fromEntries(fields.map(f => [f.name, f]))
  expect(byName.primarySubName.type).toBe('String')
  expect(byName.primarySubName.isRequired).toBe(false)
})

test('StreakReward ledger exists with typed per-reward expiry and provenance', () => {
  expect(modelNames).toContain('StreakReward')
  const fields = fieldsOf('StreakReward')
  ;['userId', 'streakId', 'type', 'grantedAt', 'expiresAt', 'consumedAt', 'itemId'].forEach(f => expect(fields).toContain(f))
  expect(valuesOf('StreakRewardType').sort()).toEqual(['POST', 'REPLY', 'TURF_DISCOUNT'])
  expect(modelNames).toContain('QuestCompletion')
  ;['userId', 'day', 'quest'].forEach(f => expect(fieldsOf('QuestCompletion')).toContain(f))
  expect(valuesOf('QuestType').sort()).toEqual(['BOOST', 'FIRST_RESPONDER', 'TURF', 'UPVOTE'])
})

test('Streak carries the ladder reward marker and the golden shield flag; ObservedTip has a tipper index', () => {
  expect(fieldsOf('Streak')).toContain('rewardLevel')
  // rev 3: the golden flame shield — armed by a cycle day 4, consumed by a
  // missed day, never carried across runs. Must default to disarmed.
  const goldActive = allModels.find(m => m.name === 'Streak')?.fields.find(f => f.name === 'goldActive')
  expect(goldActive).toBeTruthy()
  expect(goldActive.type).toBe('Boolean')
  expect(goldActive.default).toBe(false)
  // DMMF does not model secondary indexes; assert them on the raw schema text.
  const { readFileSync } = require('fs')
  const schema = readFileSync('prisma/schema.prisma', 'utf8')
  const tip = schema.match(/model ObservedTip \{[\s\S]*?\n\}/)[0]
  expect(tip).toMatch(/@@index\(\[tipperId, state, detectedAt\]\)/)
})

test('rewards accounting separates frozen terms, receipts, fees and repair audit', () => {
  expect(fieldsOf('Item')).toContain('bountyFeePiconeros')
  expect(fieldsOf('FeeObservation')).toEqual(expect.arrayContaining(['walletReceipt', 'rewardsPiconeros']))
  expect(fieldsOf('RewardDistribution')).toContain('opsNetworkFeesAccountedPiconeros')
  expect(modelNames).toEqual(expect.arrayContaining(['RewardsWalletTransaction', 'RewardsWalletReconciliation']))
  const field = allModels.find(m => m.name === 'Item').fields.find(f => f.name === 'bountyFeePiconeros')
  expect(field.isRequired).toBe(false)
  expect(field.type).toBe('BigInt')
})
