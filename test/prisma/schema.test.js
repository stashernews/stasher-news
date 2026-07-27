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
  'Vault'
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
  // (migration 20260209000000_evergreen_ranking). Their units are now
  // piconeros, but the names must not change or the trigger breaks.
  for (const c of [
    'msats', 'downMsats', 'boost', 'cost',
    'commentMsats', 'commentCost', 'commentBoost', 'commentDownMsats',
    'ranktop', 'litCenteredSum', 'litCenteredAt', 'ranklit'
  ]) {
    expect(fields).toContain(c)
  }
})

test('Item has the new StealthNews subaddress columns', () => {
  const fields = fieldsOf('Item')
  for (const c of ['subaddressIndexMajor', 'subaddressIndexMinor', 'subaddress', 'moneroAccountId', 'subaddresses']) {
    expect(fields).toContain(c)
  }
})

test('User has the StealthNews Monero fields and no custodial balance fields', () => {
  const fields = fieldsOf('User')
  for (const c of ['moneroAddress', 'privacyMode', 'stackedPiconeros', 'downvotePiconeros', 'tipDefaultPiconeros', 'moneroAccounts', 'rewardPayouts']) {
    expect(fields).toContain(c)
  }
  for (const removed of ['msats', 'mcredits', 'vaultKeyHash', 'hasSendWallet', 'hasRecvWallet', 'autoWithdrawThreshold']) {
    expect(fields).not.toContain(removed)
  }
})

test('PayInType and PayInState enums are reduced to the StealthNews set', () => {
  expect(valuesOf('PayInType').sort()).toEqual([
    'BOOST', 'DONATE', 'DOWN_ZAP', 'ITEM_CREATE', 'ITEM_UPDATE',
    'MEDIA_UPLOAD', 'POLL_VOTE', 'TERRITORY_BILLING', 'TERRITORY_CREATE',
    'TERRITORY_UNARCHIVE', 'ZAP'
  ])
  expect(valuesOf('PayInState').sort()).toEqual(['CONFIRMED', 'DETECTED', 'FAILED', 'PENDING_PAYMENT'])
})
