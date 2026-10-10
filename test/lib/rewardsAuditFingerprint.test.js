/* eslint-env jest */

// Task 1 (rewards reconciliation): the shared, closed `accounting:v2:`
// fingerprint contract. These tests pin the COMPLETE projection inventory —
// one freshness mutation per inventoried field — plus order independence,
// Date/ISO equivalence, duplicate/invalid retention, missing-vs-null-vs-invalid
// semantics, secret-sentinel exclusion and strict freshness comparison.
// Pure only: no DB, no wallet, no key provider.

import { canonicalPaymentJson } from '@/api/monero/paymentClaims'
import {
  ACCOUNTING_FINGERPRINT_VERSION,
  accountingAuditFingerprint,
  accountingAuditProjection,
  isCurrentAccountingFingerprint
} from '@/lib/rewardsAuditFingerprint'
import { auditLedgerFixture } from '@/test/fixtures/payment-proof'

const altHash = seed => seed.toString(16).padStart(2, '0').repeat(32)
const altUuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const altDate = () => new Date('2026-09-15T12:34:56.789Z')
const laterBy = (date, ms) => new Date(date.getTime() + ms)

// ---------------------------------------------------------------------------
// The projection inventory table: exactly one non-net-changing mutation per
// inventoried field (offsetting receipt edits above stand in for the sum
// invariance; every other field changes alone and must move the fingerprint).
// Field lists mirror the plan's inventory table verbatim.
// ---------------------------------------------------------------------------

const FRESHNESS_MUTATIONS = [
  // Scope/derivation
  ['scope.network', f => { f.scope.network = 'MAINNET' }],
  ['scope.walletAddress', f => { f.scope.walletAddress += 'changed' }],
  ['ledger.accounts[].id', f => { f.ledger.accounts[0].id = 3 }],
  ['ledger.accounts[].label', f => { f.ledger.accounts[0].label = 'another_wallet' }],
  ['ledger.accounts[].network', f => { f.ledger.accounts[0].network = 'MAINNET' }],
  ['ledger.accounts[].address', f => { f.ledger.accounts[0].address += 'changed' }],
  ['ledger.subaddresses[].id', f => { f.ledger.subaddresses[0].id = 99 }],
  ['ledger.subaddresses[].accountId', f => { f.ledger.subaddresses[0].accountId = 2 }],
  ['ledger.subaddresses[].majorIndex', f => { f.ledger.subaddresses[0].majorIndex = 1 }],
  ['ledger.subaddresses[].minorIndex', f => { f.ledger.subaddresses[0].minorIndex = 1 }],
  ['ledger.subaddresses[].address', f => { f.ledger.subaddresses[0].address += 'changed' }],
  ['ledger.subaddresses[].state', f => { f.ledger.subaddresses[0].state = 'ASSIGNED' }],
  // FeeObservation
  ['ledger.receipts[].id', f => { f.ledger.receipts[0].id = 199n }],
  ['ledger.receipts[].txHash', f => { f.ledger.receipts[0].txHash = altHash(0x71) }],
  ['ledger.receipts[].feeType', f => { f.ledger.receipts[0].feeType = 'DONATE' }],
  ['ledger.receipts[].postId', f => { f.ledger.receipts[0].postId = 509 }],
  ['ledger.receipts[].subName', f => { f.ledger.receipts[0].subName = 'terry' }],
  ['ledger.receipts[].payInId', f => { f.ledger.receipts[0].payInId = 6003 }],
  ['ledger.receipts[].recipientMajor', f => { f.ledger.receipts[0].recipientMajor = 2 }],
  ['ledger.receipts[].recipientMinor', f => { f.ledger.receipts[0].recipientMinor = 1 }],
  ['ledger.receipts[].walletReceipt', f => { f.ledger.receipts[0].walletReceipt = false }],
  ['ledger.receipts[].state', f => { f.ledger.receipts[0].state = 'PENDING' }],
  ['ledger.receipts[].piconeros', f => { f.ledger.receipts[0].piconeros += 1n }],
  ['ledger.receipts[].rewardsPiconeros', f => { f.ledger.receipts[0].rewardsPiconeros = 1n }],
  ['ledger.receipts[].donationRewardsPct', f => { f.ledger.receipts[0].donationRewardsPct = 60 }],
  ['ledger.receipts[].height', f => { f.ledger.receipts[0].height += 1 }],
  ['ledger.receipts[].confirmedAt', f => { f.ledger.receipts[0].confirmedAt = laterBy(f.ledger.receipts[0].confirmedAt, 60000) }],
  // ObservedDownvote (no recipient account/index columns exist)
  ['ledger.downvotes[].id', f => { f.ledger.downvotes[0].id = 299n }],
  ['ledger.downvotes[].txHash', f => { f.ledger.downvotes[0].txHash = altHash(0x72) }],
  ['ledger.downvotes[].paymentId', f => { f.ledger.downvotes[0].paymentId = 'f'.repeat(16) }],
  ['ledger.downvotes[].postId', f => { f.ledger.downvotes[0].postId = 509 }],
  ['ledger.downvotes[].downvoterId', f => { f.ledger.downvotes[0].downvoterId = 8 }],
  ['ledger.downvotes[].state', f => { f.ledger.downvotes[0].state = 'REORGED' }],
  ['ledger.downvotes[].piconeros', f => { f.ledger.downvotes[0].piconeros += 1n }],
  ['ledger.downvotes[].height', f => { f.ledger.downvotes[0].height += 1 }],
  ['ledger.downvotes[].confirmedAt', f => { f.ledger.downvotes[0].confirmedAt = laterBy(f.ledger.downvotes[0].confirmedAt, 60000) }],
  // Config/reserve: one mutation per percentage — never one whole-config test
  ['config.downvoteRewardsPct', f => { f.config.downvoteRewardsPct = 90 }],
  ['config.postingFeeRewardsPct', f => { f.config.postingFeeRewardsPct = 71 }],
  ['config.territoryFeeRewardsPct', f => { f.config.territoryFeeRewardsPct = 31 }],
  ['config.boostRewardsPct', f => { f.config.boostRewardsPct = 31 }],
  ['config.walletlessTipRewardsPct', f => { f.config.walletlessTipRewardsPct = 71 }],
  ['reserve.feeHeadroomPiconeros', f => { f.reserve.feeHeadroomPiconeros += 1n }],
  ['reserve.dustFloorPiconeros', f => { f.reserve.dustFloorPiconeros += 1n }],
  // RewardDistribution
  ['ledger.distributions[].id', f => { f.ledger.distributions[0].id = 499 }],
  ['ledger.distributions[].status', f => { f.ledger.distributions[0].status = 'PENDING' }],
  ['ledger.distributions[].periodStart', f => { f.ledger.distributions[0].periodStart = laterBy(f.ledger.distributions[0].periodStart, 60000) }],
  ['ledger.distributions[].periodEnd', f => { f.ledger.distributions[0].periodEnd = laterBy(f.ledger.distributions[0].periodEnd, 60000) }],
  ['ledger.distributions[].poolPiconeros', f => { f.ledger.distributions[0].poolPiconeros += 1n }],
  ['ledger.distributions[].distributedPiconeros', f => { f.ledger.distributions[0].distributedPiconeros += 1n }],
  ['ledger.distributions[].rolledOverPiconeros', f => { f.ledger.distributions[0].rolledOverPiconeros += 1n }],
  ['ledger.distributions[].payoutCount', f => { f.ledger.distributions[0].payoutCount = 2 }],
  ['ledger.distributions[].opsInflowPiconeros', f => { f.ledger.distributions[0].opsInflowPiconeros += 1n }],
  ['ledger.distributions[].opsRolledOverPiconeros', f => { f.ledger.distributions[0].opsRolledOverPiconeros += 1n }],
  ['ledger.distributions[].opsAvailablePiconeros', f => { f.ledger.distributions[0].opsAvailablePiconeros += 1n }],
  ['ledger.distributions[].opsSweptPiconeros', f => { f.ledger.distributions[0].opsSweptPiconeros += 1n }],
  ['ledger.distributions[].opsSweepState', f => { f.ledger.distributions[0].opsSweepState = 'NOT_SWEEPED' }],
  ['ledger.distributions[].opsSweepTxHash', f => { f.ledger.distributions[0].opsSweepTxHash = altHash(0x73) }],
  ['ledger.distributions[].opsNetworkFeesAccountedPiconeros', f => { f.ledger.distributions[0].opsNetworkFeesAccountedPiconeros += 1n }],
  // RewardPayout
  ['ledger.payouts[].id', f => { f.ledger.payouts[0].id = 399 }],
  ['ledger.payouts[].distributionId', f => { f.ledger.payouts[0].distributionId = 402 }],
  ['ledger.payouts[].curatorId', f => { f.ledger.payouts[0].curatorId = 8 }],
  ['ledger.payouts[].recipientAddress', f => { f.ledger.payouts[0].recipientAddress += 'changed' }],
  ['ledger.payouts[].piconeros', f => { f.ledger.payouts[0].piconeros += 1n }],
  ['ledger.payouts[].state', f => { f.ledger.payouts[0].state = 'CONFIRMED' }],
  ['ledger.payouts[].txHash', f => { f.ledger.payouts[0].txHash = altHash(0x74) }],
  // RewardsWalletTransaction
  ['ledger.transactions[].id', f => { f.ledger.transactions[0].id = 599n }],
  ['ledger.transactions[].network', f => { f.ledger.transactions[0].network = 'MAINNET' }],
  ['ledger.transactions[].walletAddress', f => { f.ledger.transactions[0].walletAddress += 'changed' }],
  ['ledger.transactions[].txHash', f => { f.ledger.transactions[0].txHash = altHash(0x75) }],
  ['ledger.transactions[].kind', f => { f.ledger.transactions[0].kind = 'OPS_SWEEP' }],
  ['ledger.transactions[].accountIndex', f => { f.ledger.transactions[0].accountIndex = 1 }],
  ['ledger.transactions[].distributionId', f => { f.ledger.transactions[0].distributionId = null }],
  ['ledger.transactions[].principalPiconeros', f => { f.ledger.transactions[0].principalPiconeros += 1n }],
  ['ledger.transactions[].networkFeePiconeros', f => { f.ledger.transactions[0].networkFeePiconeros += 1n }],
  ['ledger.transactions[].metadata', f => { f.ledger.transactions[0].metadata = { ...f.ledger.transactions[0].metadata, extra: 'changed' } }],
  ['ledger.transactions[].state', f => { f.ledger.transactions[0].state = 'PREPARED' }],
  ['ledger.transactions[].preparedAt', f => { f.ledger.transactions[0].preparedAt = laterBy(f.ledger.transactions[0].preparedAt, 60000) }],
  ['ledger.transactions[].relayAttemptedAt', f => { f.ledger.transactions[0].relayAttemptedAt = laterBy(f.ledger.transactions[0].relayAttemptedAt, 60000) }],
  ['ledger.transactions[].relayedAt', f => { f.ledger.transactions[0].relayedAt = laterBy(f.ledger.transactions[0].relayedAt, 60000) }],
  ['ledger.transactions[].relayProvenance', f => { f.ledger.transactions[0].relayProvenance = 'SELF_RELAY' }],
  ['ledger.transactions[].dispatchId', f => { f.ledger.transactions[0].dispatchId = altUuid(91) }],
  ['ledger.transactions[].captureContractVersion', f => { f.ledger.transactions[0].captureContractVersion = 2 }],
  ['ledger.transactions[].claimDigest', f => { f.ledger.transactions[0].claimDigest = altHash(0x76) }],
  ['ledger.transactions[].paymentClaims', f => { f.ledger.transactions[0].paymentClaims = { txHash: altHash(0x77), principalPiconeros: '401' } }],
  ['ledger.transactions[].proofId', f => { f.ledger.transactions[0].proofId = altUuid(92) }],
  // Proof inventory (owner / reference / safe proof metadata)
  ['ledger.proofInventory[].owner.journalRole', f => { f.ledger.proofInventory[0].owner.journalRole = 'ESCROW' }],
  ['ledger.proofInventory[].owner.journalId', f => { f.ledger.proofInventory[0].owner.journalId = 599n }],
  ['ledger.proofInventory[].reference.txHash', f => { f.ledger.proofInventory[0].reference.txHash = altHash(0x78) }],
  ['ledger.proofInventory[].reference.kind', f => { f.ledger.proofInventory[0].reference.kind = 'OPS_SWEEP' }],
  ['ledger.proofInventory[].reference.dispatchId', f => { f.ledger.proofInventory[0].reference.dispatchId = altUuid(93) }],
  ['ledger.proofInventory[].proof.proofId', f => { f.ledger.proofInventory[0].proof.proofId = altUuid(94) }],
  ['ledger.proofInventory[].proof.revision', f => { f.ledger.proofInventory[0].proof.revision = 2 }],
  ['ledger.proofInventory[].proof.masterKeyVersion', f => { f.ledger.proofInventory[0].proof.masterKeyVersion = 2 }],
  ['ledger.proofInventory[].proof.bindingVersion', f => { f.ledger.proofInventory[0].proof.bindingVersion = 2 }],
  ['ledger.proofInventory[].proof.envelopeVersion', f => { f.ledger.proofInventory[0].proof.envelopeVersion = 2 }],
  ['ledger.proofInventory[].proof.payloadVersion', f => { f.ledger.proofInventory[0].proof.payloadVersion = 2 }],
  ['ledger.proofInventory[].proof.claimDigest', f => { f.ledger.proofInventory[0].proof.claimDigest = altHash(0x79) }],
  ['ledger.proofInventory[].proof.bindingDigest', f => { f.ledger.proofInventory[0].proof.bindingDigest = altHash(0x7a) }],
  ['ledger.proofInventory[].proof.envelopeIntegrityDigest', f => { f.ledger.proofInventory[0].proof.envelopeIntegrityDigest = altHash(0x7b) }],
  ['ledger.proofInventory[].reference.leg (escrow entry)', f => { f.ledger.proofInventory[1].reference.leg = 'LEGACY_SEPARATE_FEE' }],
  ['ledger.proofInventory[].reference.bountyPaymentId (escrow entry)', f => { f.ledger.proofInventory[1].reference.bountyPaymentId = 799 }],
  ['ledger.proofInventory[].reference.itemId (escrow entry)', f => { f.ledger.proofInventory[1].reference.itemId = 599 }],
  // EscrowWalletTransaction
  ['ledger.escrowTransactions[].id', f => { f.ledger.escrowTransactions[0].id = 699n }],
  ['ledger.escrowTransactions[].network', f => { f.ledger.escrowTransactions[0].network = 'MAINNET' }],
  ['ledger.escrowTransactions[].walletAddress', f => { f.ledger.escrowTransactions[0].walletAddress += 'changed' }],
  ['ledger.escrowTransactions[].txHash', f => { f.ledger.escrowTransactions[0].txHash = altHash(0x7c) }],
  ['ledger.escrowTransactions[].dispatchId', f => { f.ledger.escrowTransactions[0].dispatchId = altUuid(95) }],
  ['ledger.escrowTransactions[].proofId', f => { f.ledger.escrowTransactions[0].proofId = altUuid(96) }],
  ['ledger.escrowTransactions[].captureContractVersion', f => { f.ledger.escrowTransactions[0].captureContractVersion = 2 }],
  ['ledger.escrowTransactions[].claimDigest', f => { f.ledger.escrowTransactions[0].claimDigest = altHash(0x7d) }],
  ['ledger.escrowTransactions[].paymentClaims', f => { f.ledger.escrowTransactions[0].paymentClaims = { txHash: altHash(0x7e), principalPiconeros: '5001' } }],
  ['ledger.escrowTransactions[].kind', f => { f.ledger.escrowTransactions[0].kind = 'RECLAIM' }],
  ['ledger.escrowTransactions[].leg', f => { f.ledger.escrowTransactions[0].leg = 'LEGACY_SEPARATE_FEE' }],
  ['ledger.escrowTransactions[].bountyPaymentId', f => { f.ledger.escrowTransactions[0].bountyPaymentId = 799 }],
  ['ledger.escrowTransactions[].itemId', f => { f.ledger.escrowTransactions[0].itemId = 599 }],
  ['ledger.escrowTransactions[].accountIndex', f => { f.ledger.escrowTransactions[0].accountIndex = 1 }],
  ['ledger.escrowTransactions[].principalPiconeros', f => { f.ledger.escrowTransactions[0].principalPiconeros += 1n }],
  ['ledger.escrowTransactions[].networkFeePiconeros', f => { f.ledger.escrowTransactions[0].networkFeePiconeros += 1n }],
  ['ledger.escrowTransactions[].metadata', f => { f.ledger.escrowTransactions[0].metadata = { ...f.ledger.escrowTransactions[0].metadata, extra: 'changed' } }],
  ['ledger.escrowTransactions[].state', f => { f.ledger.escrowTransactions[0].state = 'NOT_RELAYED' }],
  ['ledger.escrowTransactions[].preparedAt', f => { f.ledger.escrowTransactions[0].preparedAt = laterBy(f.ledger.escrowTransactions[0].preparedAt, 60000) }],
  ['ledger.escrowTransactions[].relayAttemptedAt', f => { f.ledger.escrowTransactions[0].relayAttemptedAt = laterBy(f.ledger.escrowTransactions[0].relayAttemptedAt, 60000) }],
  ['ledger.escrowTransactions[].relayedAt', f => { f.ledger.escrowTransactions[0].relayedAt = laterBy(f.ledger.escrowTransactions[0].relayedAt, 60000) }],
  ['ledger.escrowTransactions[].relayProvenance', f => { f.ledger.escrowTransactions[0].relayProvenance = 'SELF_RELAY' }],
  // BountyPayment
  ['ledger.bountyPayments[].id', f => { f.ledger.bountyPayments[0].id = 799 }],
  ['ledger.bountyPayments[].itemId', f => { f.ledger.bountyPayments[0].itemId = 599 }],
  ['ledger.bountyPayments[].winnerUserId', f => { f.ledger.bountyPayments[0].winnerUserId = 10 }],
  ['ledger.bountyPayments[].kind', f => { f.ledger.bountyPayments[0].kind = 'RECLAIM' }],
  ['ledger.bountyPayments[].piconeros', f => { f.ledger.bountyPayments[0].piconeros += 1n }],
  ['ledger.bountyPayments[].feePiconeros', f => { f.ledger.bountyPayments[0].feePiconeros += 1n }],
  ['ledger.bountyPayments[].recipientAddress', f => { f.ledger.bountyPayments[0].recipientAddress += 'changed' }],
  ['ledger.bountyPayments[].feeRecipientAddress', f => { f.ledger.bountyPayments[0].feeRecipientAddress += 'changed' }],
  ['ledger.bountyPayments[].state', f => { f.ledger.bountyPayments[0].state = 'SENT' }],
  ['ledger.bountyPayments[].txHash', f => { f.ledger.bountyPayments[0].txHash = altHash(0x81) }],
  ['ledger.bountyPayments[].feeTxHash', f => { f.ledger.bountyPayments[0].feeTxHash = altHash(0x82) }],
  ['ledger.bountyPayments[].feePendingAt', f => { f.ledger.bountyPayments[0].feePendingAt = laterBy(f.ledger.bountyPayments[0].feePendingAt, 60000) }],
  ['ledger.bountyPayments[].networkFeePiconeros', f => { f.ledger.bountyPayments[0].networkFeePiconeros += 1n }],
  ['ledger.bountyPayments[].recipientReceivedPiconeros', f => { f.ledger.bountyPayments[0].recipientReceivedPiconeros += 1n }],
  ['ledger.bountyPayments[].feeReceivedPiconeros', f => { f.ledger.bountyPayments[0].feeReceivedPiconeros += 1n }],
  ['ledger.bountyPayments[].feeSettlementNetworkFeePiconeros', f => { f.ledger.bountyPayments[0].feeSettlementNetworkFeePiconeros += 1n }],
  ['ledger.bountyPayments[].sentAt', f => { f.ledger.bountyPayments[0].sentAt = laterBy(f.ledger.bountyPayments[0].sentAt, 60000) }],
  ['ledger.bountyPayments[].confirmedAt', f => { f.ledger.bountyPayments[0].confirmedAt = laterBy(f.ledger.bountyPayments[0].confirmedAt, 60000) }],
  ['ledger.bountyPayments[].height', f => { f.ledger.bountyPayments[0].height += 1 }],
  // Funding/terms: ObservedBounty / ObservedBountyReceipt / Item
  ['ledger.observedBounties[].id', f => { f.ledger.observedBounties[0].id = 899n }],
  ['ledger.observedBounties[].postId', f => { f.ledger.observedBounties[0].postId = 599 }],
  ['ledger.observedBounties[].payerId', f => { f.ledger.observedBounties[0].payerId = 13 }],
  ['ledger.observedBounties[].recipientAccountId', f => { f.ledger.observedBounties[0].recipientAccountId = 3 }],
  ['ledger.observedBounties[].paymentId', f => { f.ledger.observedBounties[0].paymentId = 'f'.repeat(16) }],
  ['ledger.observedBounties[].txHash', f => { f.ledger.observedBounties[0].txHash = altHash(0x83) }],
  ['ledger.observedBounties[].piconeros', f => { f.ledger.observedBounties[0].piconeros += 1n }],
  ['ledger.observedBounties[].state', f => { f.ledger.observedBounties[0].state = 'DETECTED' }],
  ['ledger.observedBounties[].height', f => { f.ledger.observedBounties[0].height += 1 }],
  ['ledger.observedBounties[].confirmedAt', f => { f.ledger.observedBounties[0].confirmedAt = laterBy(f.ledger.observedBounties[0].confirmedAt, 60000) }],
  ['ledger.observedBountyReceipts[].id', f => { f.ledger.observedBountyReceipts[0].id = 999n }],
  ['ledger.observedBountyReceipts[].bountyId', f => { f.ledger.observedBountyReceipts[0].bountyId = 899n }],
  ['ledger.observedBountyReceipts[].txHash', f => { f.ledger.observedBountyReceipts[0].txHash = altHash(0x84) }],
  ['ledger.observedBountyReceipts[].piconeros', f => { f.ledger.observedBountyReceipts[0].piconeros += 1n }],
  ['ledger.observedBountyReceipts[].height', f => { f.ledger.observedBountyReceipts[0].height += 1 }],
  ['ledger.observedBountyReceipts[].detectedAt', f => { f.ledger.observedBountyReceipts[0].detectedAt = laterBy(f.ledger.observedBountyReceipts[0].detectedAt, 60000) }],
  ['ledger.items[].id', f => { f.ledger.items[0].id = 599 }],
  ['ledger.items[].bountyPiconeros', f => { f.ledger.items[0].bountyPiconeros += 1n }],
  ['ledger.items[].bountyFeePiconeros', f => { f.ledger.items[0].bountyFeePiconeros += 1n }],
  ['ledger.items[].bountyPiconeros (in-flight item)', f => { f.ledger.items[1].bountyPiconeros += 1n }],
  ['ledger.items[].bountyFeePiconeros (in-flight item)', f => { f.ledger.items[1].bountyFeePiconeros = 7n }],
  // Protected contracts: Earn
  ['ledger.earns[].id', f => { f.ledger.earns[0].id = 1099 }],
  ['ledger.earns[].userId', f => { f.ledger.earns[0].userId = 8 }],
  ['ledger.earns[].distributionId', f => { f.ledger.earns[0].distributionId = 402 }],
  ['ledger.earns[].piconeros', f => { f.ledger.earns[0].piconeros += 1n }]
]

describe('accountingAuditFingerprint freshness matrix', () => {
  test('offsetting receipt edits change freshness despite unchanged sums', () => {
    const input = auditLedgerFixture()
    const changed = structuredClone(input)
    changed.ledger.receipts[0].piconeros += 1n
    changed.ledger.receipts[1].piconeros -= 1n
    expect(accountingAuditFingerprint(changed)).not.toBe(accountingAuditFingerprint(input))
  })

  test.each(['bare-legacy-hash', 'accounting:v1:' + 'a'.repeat(64), null])(
    'old or absent fingerprint %p is stale', stored => {
      expect(isCurrentAccountingFingerprint(stored, accountingAuditFingerprint(auditLedgerFixture()))).toBe(false)
    }
  )

  test.each(FRESHNESS_MUTATIONS)('%s moves the fingerprint', (_name, mutate) => {
    const input = auditLedgerFixture()
    const changed = structuredClone(input)
    mutate(changed)
    expect(accountingAuditFingerprint(changed)).not.toBe(accountingAuditFingerprint(input))
  })

  test('the current fingerprint string is strictly accepted only in v2 form', () => {
    const current = accountingAuditFingerprint(auditLedgerFixture())
    expect(ACCOUNTING_FINGERPRINT_VERSION).toBe(2)
    expect(current).toMatch(/^accounting:v2:[0-9a-f]{64}$/)
    expect(isCurrentAccountingFingerprint(current, current)).toBe(true)
    // any mutation of a v2 string, and non-string stored values, are stale
    expect(isCurrentAccountingFingerprint(current.toUpperCase(), current)).toBe(false)
    expect(isCurrentAccountingFingerprint(` ${current}`, current)).toBe(false)
    expect(isCurrentAccountingFingerprint(undefined, current)).toBe(false)
    expect(isCurrentAccountingFingerprint(42, current)).toBe(false)
    // a malformed "current" can never validate anything (fail closed)
    expect(isCurrentAccountingFingerprint('bare-hash', 'bare-hash')).toBe(false)
    expect(isCurrentAccountingFingerprint(null, null)).toBe(false)
  })

  test('the fingerprint is deterministic across calls', () => {
    expect(accountingAuditFingerprint(auditLedgerFixture()))
      .toBe(accountingAuditFingerprint(auditLedgerFixture()))
  })
})

describe('accountingAuditProjection canonical semantics', () => {
  test('input order never changes the projection or fingerprint', () => {
    const input = auditLedgerFixture()
    const reordered = structuredClone(input)
    for (const group of Object.keys(reordered.ledger)) {
      if (Array.isArray(reordered.ledger[group])) reordered.ledger[group].reverse()
    }
    expect(accountingAuditFingerprint(reordered)).toBe(accountingAuditFingerprint(input))
    expect(accountingAuditProjection(reordered)).toEqual(accountingAuditProjection(input))
  })

  test('Date and ISO-string timestamps are equivalent', () => {
    const input = auditLedgerFixture()
    const iso = structuredClone(input)
    iso.ledger.receipts[0].confirmedAt = input.ledger.receipts[0].confirmedAt.toISOString()
    iso.ledger.distributions[0].periodStart = input.ledger.distributions[0].periodStart.toISOString()
    iso.ledger.transactions[0].relayedAt = input.ledger.transactions[0].relayedAt.toISOString()
    expect(accountingAuditFingerprint(iso)).toBe(accountingAuditFingerprint(input))
  })

  test('confirmation counters that merely advance are excluded', () => {
    const input = auditLedgerFixture()
    const advanced = structuredClone(input)
    advanced.ledger.receipts[0].confirmations += 1
    advanced.ledger.receipts[1].confirmations += 1000
    advanced.ledger.downvotes[0].confirmations += 1
    expect(accountingAuditFingerprint(advanced)).toBe(accountingAuditFingerprint(input))
    // and the closed projection never carried them in the first place
    const projected = accountingAuditProjection(input)
    for (const receipt of projected.ledger.receipts) expect('confirmations' in receipt).toBe(false)
    for (const downvote of projected.ledger.downvotes) expect('confirmations' in downvote).toBe(false)
  })

  test('secret sentinels and unknown fields never enter the projection', () => {
    const input = auditLedgerFixture()
    const poisoned = structuredClone(input)
    poisoned.ledger.receipts[0].privateViewKey = 'sentinel-view-key'
    poisoned.ledger.transactions[0].ciphertext = 'sentinel-ciphertext'
    poisoned.ledger.transactions[0].dataNonceHex = 'sentinel-nonce'
    poisoned.ledger.downvotes[0].wrappedDek = 'sentinel-dek'
    poisoned.ledger.escrowTransactions[0].signedTxBlob = 'sentinel-blob'
    expect(accountingAuditFingerprint(poisoned)).toBe(accountingAuditFingerprint(input))
    const serialized = canonicalPaymentJson(accountingAuditProjection(input))
    expect(serialized).not.toMatch(/ciphertext|nonce|wrappeddek|datatag|wraptag|viewkey|spendkey|plaintext|sentinel/i)
  })

  test('duplicate receipts are retained, never collapsed before fingerprinting', () => {
    const input = auditLedgerFixture()
    const duplicated = structuredClone(input)
    duplicated.ledger.receipts.push(structuredClone(duplicated.ledger.receipts[0]))
    expect(accountingAuditFingerprint(duplicated)).not.toBe(accountingAuditFingerprint(input))
    const reversed = structuredClone(duplicated)
    reversed.ledger.receipts.reverse()
    expect(accountingAuditFingerprint(reversed)).toBe(accountingAuditFingerprint(duplicated))
    // inserts and deletes always move the fingerprint
    const deleted = structuredClone(input)
    deleted.ledger.receipts.pop()
    const inserted = structuredClone(input)
    inserted.ledger.receipts.push(structuredClone(input.ledger.receipts[4]))
    const base = accountingAuditFingerprint(input)
    expect(accountingAuditFingerprint(deleted)).not.toBe(base)
    expect(accountingAuditFingerprint(inserted)).not.toBe(base)
  })

  test('an invalid hash with a positive material amount is retained explicitly', () => {
    const input = auditLedgerFixture()
    const projected = accountingAuditProjection(input)
    const unreadable = projected.ledger.receipts.find(row => row.id === '104')
    expect(unreadable.txHash).toEqual({ invalid: true, kind: 'HASH', raw: 'not-a-chain-hash' })
    expect(unreadable.piconeros).toBe('300')
    // and it is part of the fingerprint, not dropped
    const without = structuredClone(input)
    without.ledger.receipts = without.ledger.receipts.filter(row => row.id !== 104n)
    expect(accountingAuditFingerprint(without)).not.toBe(accountingAuditFingerprint(input))
  })

  test('uppercase hex hashes normalize while malformed hashes keep their raw text', () => {
    const input = auditLedgerFixture()
    const upper = structuredClone(input)
    upper.ledger.receipts[0].txHash = input.ledger.receipts[0].txHash.toUpperCase()
    expect(accountingAuditFingerprint(upper)).toBe(accountingAuditFingerprint(input))
    const projected = accountingAuditProjection(upper)
    expect(projected.ledger.receipts[0].txHash).toMatch(/^[0-9a-f]{64}$/)
    const broken = structuredClone(input)
    broken.ledger.receipts[0].txHash = 'ZEBRA'
    expect(accountingAuditProjection(broken).ledger.receipts[0].txHash)
      .toEqual({ invalid: true, kind: 'HASH', raw: 'ZEBRA' })
    expect(accountingAuditFingerprint(broken)).not.toBe(accountingAuditFingerprint(input))
  })

  test('canonical IDs are representation-independent exact identities', () => {
    // Final-review M1: a safe nonnegative number, its BigInt form and its
    // canonical decimal string are the SAME exact id — one projected identity,
    // one fingerprint. The audit identifier can never depend on the JS
    // representation that carried the value.
    const input = auditLedgerFixture()
    const numeric = structuredClone(input)
    const bigintForm = structuredClone(input)
    const stringForm = structuredClone(input)
    numeric.ledger.receipts[0].id = 1234
    bigintForm.ledger.receipts[0].id = 1234n
    stringForm.ledger.receipts[0].id = '1234'
    expect(accountingAuditProjection(numeric).ledger.receipts[0].id).toBe('1234')
    expect(accountingAuditProjection(bigintForm).ledger.receipts[0].id).toBe('1234')
    expect(accountingAuditProjection(stringForm).ledger.receipts[0].id).toBe('1234')
    expect(accountingAuditFingerprint(stringForm)).toBe(accountingAuditFingerprint(numeric))
    expect(accountingAuditFingerprint(bigintForm)).toBe(accountingAuditFingerprint(numeric))
    // Unsupported exact-value forms are explicit invalids — never rounded,
    // never reinterpreted, never silently aliased to the canonical identity.
    const unsafe = structuredClone(input)
    unsafe.ledger.receipts[0].id = 2 ** 53
    expect(accountingAuditProjection(unsafe).ledger.receipts[0].id)
      .toEqual({ invalid: true, kind: 'ID', raw: String(2 ** 53) })
    const negative = structuredClone(input)
    negative.ledger.receipts[0].id = -7
    expect(accountingAuditProjection(negative).ledger.receipts[0].id)
      .toEqual({ invalid: true, kind: 'ID', raw: '-7' })
    const nonCanonical = structuredClone(input)
    nonCanonical.ledger.receipts[0].id = '01234'
    expect(accountingAuditProjection(nonCanonical).ledger.receipts[0].id)
      .toEqual({ invalid: true, kind: 'ID', raw: '01234' })
    expect(accountingAuditFingerprint(unsafe)).not.toBe(accountingAuditFingerprint(input))
    expect(accountingAuditFingerprint(negative)).not.toBe(accountingAuditFingerprint(input))
    expect(accountingAuditFingerprint(nonCanonical)).not.toBe(accountingAuditFingerprint(input))
  })

  test('unsafe number amounts are explicit invalids, never normalized values', () => {
    const input = auditLedgerFixture()
    const broken = structuredClone(input)
    broken.ledger.receipts[0].piconeros = 700.5
    expect(accountingAuditProjection(broken).ledger.receipts[0].piconeros)
      .toEqual({ invalid: true, kind: 'AMOUNT', raw: '700.5' })
    expect(accountingAuditFingerprint(broken)).not.toBe(accountingAuditFingerprint(input))
    // a safe-looking integer is still not money: BigInt piconeros everywhere
    const integerAmount = structuredClone(input)
    integerAmount.ledger.receipts[0].piconeros = 700
    expect(accountingAuditProjection(integerAmount).ledger.receipts[0].piconeros)
      .toEqual({ invalid: true, kind: 'AMOUNT', raw: '700' })
    // canonical decimal strings are equivalent to their BigInt form
    const asString = structuredClone(input)
    asString.ledger.receipts[0].piconeros = '700'
    expect(accountingAuditFingerprint(asString)).toBe(accountingAuditFingerprint(input))
  })

  test('missing, null and invalid are distinct semantics for a nullable column', () => {
    const input = auditLedgerFixture()
    const nulled = structuredClone(input)
    nulled.ledger.receipts[1].rewardsPiconeros = null
    const invalid = structuredClone(input)
    invalid.ledger.receipts[1].rewardsPiconeros = '12x'
    const fingerprints = new Set([
      accountingAuditFingerprint(input),
      accountingAuditFingerprint(nulled),
      accountingAuditFingerprint(invalid)
    ])
    expect(fingerprints.size).toBe(3)
    expect(accountingAuditProjection(nulled).ledger.receipts[1].rewardsPiconeros).toBeNull()
    expect(accountingAuditProjection(invalid).ledger.receipts[1].rewardsPiconeros)
      .toEqual({ invalid: true, kind: 'AMOUNT', raw: '12x' })
    // an expected column that is absent is an error, not a silent null
    const missing = structuredClone(input)
    delete missing.ledger.receipts[1].rewardsPiconeros
    expect(() => accountingAuditFingerprint(missing)).toThrow(/rewardsPiconeros/)
  })

  test('missing required structures fail closed', () => {
    const input = auditLedgerFixture()
    expect(() => accountingAuditFingerprint(null)).toThrow(/input/)
    expect(() => accountingAuditFingerprint({ ...input, scope: null })).toThrow(/scope/)
    expect(() => accountingAuditFingerprint({ ...input, scope: { network: 'DEVNET', walletAddress: 'x' } })).toThrow(/network/)
    expect(() => accountingAuditFingerprint({ ...input, ledger: null })).toThrow(/ledger/)
    const noGroup = structuredClone(input)
    delete noGroup.ledger.receipts
    expect(() => accountingAuditFingerprint(noGroup)).toThrow(/receipts/)
    expect(() => accountingAuditFingerprint({ ...input, config: null })).toThrow(/config/)
    expect(() => accountingAuditFingerprint({ ...input, reserve: null })).toThrow(/reserve/)
    const noPct = structuredClone(input)
    delete noPct.config.boostRewardsPct
    expect(() => accountingAuditFingerprint(noPct)).toThrow(/boostRewardsPct/)
    const noReserveField = structuredClone(input)
    delete noReserveField.reserve.dustFloorPiconeros
    expect(() => accountingAuditFingerprint(noReserveField)).toThrow(/dustFloorPiconeros/)
  })

  test('the downvote receiving scope is the derived platform primary address', () => {
    const input = auditLedgerFixture()
    const projected = accountingAuditProjection(input)
    // Downvotes pay the rewards PRIMARY address: (0,0) derived from the proven
    // scope — never an invented minor index per row.
    expect(projected.scope.downvoteReceivingScope).toEqual({
      majorIndex: 0,
      minorIndex: 0,
      address: input.scope.walletAddress
    })
    // every ObservedDownvote row is projected with its payment identity
    for (const row of projected.ledger.downvotes) {
      expect(row.txHash).toMatch(/^[0-9a-f]{64}$/)
      expect(typeof row.paymentId).toBe('string')
      expect('recipientMajor' in row).toBe(false)
      expect('recipientMinor' in row).toBe(false)
    }
  })

  test('pending receipt state changes move the fingerprint without delivery changes', () => {
    const input = auditLedgerFixture()
    // the PENDING donation receipt is chain-addressable and already audited
    const pending = input.ledger.receipts.find(row => row.state === 'PENDING')
    expect(pending.height).toBeNull()
    const matured = structuredClone(input)
    const row = matured.ledger.receipts.find(candidate => candidate.id === pending.id)
    row.state = 'CONFIRMED'
    row.height = 2999999
    row.confirmedAt = altDate()
    expect(accountingAuditFingerprint(matured)).not.toBe(accountingAuditFingerprint(input))
  })

  test('proof envelope byte integrity changes move freshness without a revision change', () => {
    const input = auditLedgerFixture()
    const tampered = structuredClone(input)
    // what the #1 store recomputes after an out-of-band envelope byte change
    tampered.ledger.proofInventory[0].proof.envelopeIntegrityDigest = altHash(0x7f)
    expect(tampered.ledger.proofInventory[0].proof.revision).toBe(1)
    expect(accountingAuditFingerprint(tampered)).not.toBe(accountingAuditFingerprint(input))
  })

  test('the projection shape carries every inventoried group and nothing else', () => {
    const projected = accountingAuditProjection(auditLedgerFixture())
    expect(Object.keys(projected).sort()).toEqual(['config', 'ledger', 'reserve', 'scope'])
    expect(Object.keys(projected.ledger).sort()).toEqual([
      'accounts', 'bountyPayments', 'distributions', 'downvotes', 'earns', 'escrowTransactions',
      'items', 'observedBountyReceipts', 'observedBounties', 'payouts', 'proofInventory',
      'receipts', 'subaddresses', 'transactions'
    ].sort())
    expect(projected.ledger.proofInventory[0].proof).toEqual({
      proofId: expect.any(String),
      revision: 1,
      masterKeyVersion: 1,
      bindingVersion: 1,
      envelopeVersion: 1,
      payloadVersion: 1,
      claimDigest: expect.any(String),
      bindingDigest: expect.any(String),
      envelopeIntegrityDigest: expect.any(String)
    })
  })
})
