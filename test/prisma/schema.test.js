/* eslint-env jest */

// Schema-presence test for the StealthNews baseline (Task 1).
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
  'ObservedBurn',
  'RewardDistribution',
  'RewardPayout',
  'DownvotePidMap',
  'PlatformFeeConfig'
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

test('stealth schema has the Monero observation models', () => {
  for (const m of EXPECTED_MODELS) {
    expect(modelNames).toContain(m)
  }
})

test('stealth schema has no custodial/Lightning residue models', () => {
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

test('Item has the StealthNews posting-fee columns (subaddress columns dropped)', () => {
  const fields = fieldsOf('Item')
  for (const c of ['feeStatus', 'feePayInId', 'feePayIn', 'observedTips', 'observedBurns']) {
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
  for (const r of ['observedTips', 'observedBurns']) {
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

test('User has the StealthNews Monero fields and no custodial balance fields', () => {
  const fields = fieldsOf('User')
  for (const c of ['moneroAddress', 'privacyMode', 'stackedPiconeros', 'downvotePiconeros', 'tipDefaultPiconeros', 'moneroAccounts', 'rewardPayouts', 'hideStashAmount']) {
    expect(fields).toContain(c)
  }
  // stackedMsats dropped (stackedPiconeros survives) and stackedMcredits renamed
  // to stackedCredits.
  for (const removed of ['stackedMsats', 'stackedMcredits', 'vaultKeyHash', 'hasSendWallet', 'hasRecvWallet', 'autoWithdrawThreshold', 'noteDeposits', 'noteWithdrawals', 'hideUriDesc', 'tipUndos']) {
    expect(fields).not.toContain(removed)
  }
})

test('PayInType and PayInState enums are reduced to the StealthNews set', () => {
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
})

test('User has no forward-notification setting residue', () => {
  expect(fieldsOf('User')).not.toContain('noteForwardedPiconeros')
})
