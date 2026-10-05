// Synthetic rewards-accounting repair input (rewards accounting repair §8,
// Task 12). Exact, unrelated small amounts — NO production approximate
// figures. The shape is exactly what `buildRewardsReconciliation` consumes:
//
//   { scope, boundary, evidence, ledger, decisions, config, reserve }
//
// Money story (all piconeros):
//   escrow funding nominal fee 20      (legacy funding-time BOUNTY_FEE row)
//   cold fee receipt 17                (actual award fee disposition)
//   hot rollover net 139 / prize 100   (historical nominal booking was 140)
//   hot payout principal 60 shared by two journal members / fee 7
//   consolidation fee 3                (self transfer, zero principal)
//   sweep principal 10 / fee 2         (proved sweep, recorded snapshot 0)
//   unbooked incoming 5                (requires an explicit operator decision)
//
//   Hot receipts excluding self transfers: 139 + 5 = 144
//   Proved external principal:              60 + 10 = 70
//   Costs:                                  7 + 3 + 2 = 12
//   Ledger balance:                         144 − 70 − 12 = 62
//   Wallet total 62 and unlocked 52 are deliberately different values.
//
// `syntheticRewardsEvidence()` returns the DEFAULT input: no operator decision
// for the unbooked incoming 5, so the manifest reports UNKNOWN_INCOMING and is
// not applicable. Call `withApprovedIncomingClassification(input)` (or pass
// `{ classifyIncoming: true }`) for the complete-evidence variant whose
// corrections reconcile the ledger to zero drift.

export const FI = Object.freeze({
  SCOPE: Object.freeze({ network: 'STAGENET', walletAddress: '5RewardsHotWalletAuditAddressPrimary' }),
  BOUNDARY: Object.freeze({ height: 3000000, blockHash: 'd4'.repeat(32) }),
  ADDRESS: Object.freeze({
    WALLET: '5RewardsHotWalletAuditAddressPrimary',
    COLD: '5RewardsColdStorageAuditAddress',
    OPS: '5OpsSweepDestinationAddress',
    CURATOR_ONE: '5CuratorOnePayoutAddress',
    CURATOR_TWO: '5CuratorTwoPayoutAddress',
    ESCROW: '5BountyEscrowWalletAddressPrimary',
    ESCROW_SUB: '5BountyEscrowBountyReceivingSubaddress'
  }),
  TX: Object.freeze({
    FUNDING: 'a1'.repeat(32),
    AWARD: 'b0'.repeat(32),
    ROLLOVER: 'b2'.repeat(32),
    PAYOUT: 'f1'.repeat(32),
    CONSOLIDATION: 'f2'.repeat(32),
    SWEEP: 'f3'.repeat(32),
    PENDING_PAYOUT: 'f4'.repeat(32),
    INCOMING: 'c3'.repeat(32),
    BRIDGE_INCOMING: 'c4'.repeat(32)
  }),
  DATE: Object.freeze({
    DIST_START: '2026-09-01T00:00:00.000Z',
    DIST_END: '2026-09-08T00:00:00.000Z',
    FUNDING: '2026-09-02T00:00:00.000Z',
    ROLLOVER: '2026-09-05T00:00:00.000Z',
    INCOMING: '2026-09-12T00:00:00.000Z'
  }),
  HEIGHT: Object.freeze({
    FUNDING: 2999000,
    AWARD: 2999200,
    PAYOUT: 2999300,
    ROLLOVER: 2999500,
    CONSOLIDATION: 2999600,
    SWEEP: 2999700,
    INCOMING: 2999900
  })
})

const { SCOPE, BOUNDARY, ADDRESS, TX, DATE, HEIGHT } = FI

// The complete-evidence operator decision for the unbooked incoming 5: an
// explicit VERIFIED classification (source, reward split, receiving index,
// evidence height and confirmedAt). Never guess this at build time.
export function approvedIncomingClassification () {
  return {
    feeType: 'BOUNTY_FEE',
    rewardsPiconeros: '0',
    recipientMajor: 0,
    recipientMinor: 0,
    confirmedAt: DATE.INCOMING,
    height: HEIGHT.INCOMING,
    verified: true
  }
}

export function withApprovedIncomingClassification (input) {
  const out = structuredClone(input)
  out.decisions.receipts[TX.INCOMING] = approvedIncomingClassification()
  return out
}

// The SCHEMA MIGRATION's observable financial handoff: every identified legacy
// funding-time accrual becomes noncash (walletReceipt=false) while its phantom
// ops contribution remains inside the stored historical distribution snapshots.
// A repair manifest must reconstruct and remove that contribution exactly once.
export function withMigrationClassifiedFunding (input) {
  const out = structuredClone(input)
  out.ledger.receipts = out.ledger.receipts.map(receipt =>
    receipt.feeType === 'BOUNTY_FEE' ? { ...receipt, walletReceipt: false } : receipt)
  return out
}

export function syntheticRewardsEvidence ({ classifyIncoming = false } = {}) {
  const input = {
    scope: SCOPE,
    boundary: BOUNDARY,
    evidence: {
      scope: SCOPE,
      boundary: BOUNDARY,
      daemon: {
        tipBefore: { height: BOUNDARY.height, blockHash: BOUNDARY.blockHash },
        tipAfter: { height: BOUNDARY.height, blockHash: BOUNDARY.blockHash }
      },
      restoreHeight: 0,
      restoreProvenance: 'genesis',
      // The wallet's height is a SCANNED BLOCK COUNT: it covers boundary index
      // BOUNDARY.height once at least BOUNDARY.height + 1 blocks are scanned.
      walletHeight: BOUNDARY.height + 1,
      derivation: {
        complete: true,
        primaryAddress: ADDRESS.WALLET,
        derived: [
          { majorIndex: 0, minorIndex: 0, address: ADDRESS.WALLET },
          { majorIndex: 1, minorIndex: 0, address: '5RewardsPostingFeeSubaddress' }
        ],
        mismatches: []
      },
      balances: {
        totalPiconeros: '62',
        unlockedPiconeros: '52',
        accounts: { 0: '62' }
      },
      incoming: [
        // The real hot rollover: net 139 arrived, booked as 140 nominal.
        {
          txHash: TX.ROLLOVER,
          accountIndex: 0,
          subaddressIndex: 0,
          amountPiconeros: '139',
          height: HEIGHT.ROLLOVER,
          inTxPool: false,
          isConfirmed: true,
          fromOwnTransaction: false,
          isSelfTransfer: false
        },
        // The consolidation's own change/self arrival — never external revenue.
        {
          txHash: TX.CONSOLIDATION,
          accountIndex: 0,
          subaddressIndex: 0,
          amountPiconeros: '27',
          height: HEIGHT.CONSOLIDATION,
          inTxPool: false,
          isConfirmed: true,
          fromOwnTransaction: true,
          isSelfTransfer: true
        },
        // The unbooked incoming 5: no ledger row, no default classification.
        {
          txHash: TX.INCOMING,
          accountIndex: 0,
          subaddressIndex: 0,
          amountPiconeros: '5',
          height: HEIGHT.INCOMING,
          inTxPool: false,
          isConfirmed: true,
          fromOwnTransaction: false,
          isSelfTransfer: false
        }
      ],
      outgoing: [
        // One payout tx, principal 60 shared by two members, real fee 7.
        {
          txHash: TX.PAYOUT,
          accountIndex: 0,
          feePiconeros: '7',
          destinations: [
            { address: ADDRESS.CURATOR_ONE, amountPiconeros: '40' },
            { address: ADDRESS.CURATOR_TWO, amountPiconeros: '20' }
          ],
          height: HEIGHT.PAYOUT,
          inTxPool: false,
          isConfirmed: true,
          isRelayed: true,
          isSelfTransfer: false,
          relayState: 'confirmed'
        },
        // Fee-only self transfer (consolidation of a fee account).
        {
          txHash: TX.CONSOLIDATION,
          accountIndex: 1,
          feePiconeros: '3',
          destinations: [{ address: ADDRESS.WALLET, amountPiconeros: '27' }],
          height: HEIGHT.CONSOLIDATION,
          inTxPool: false,
          isConfirmed: true,
          isRelayed: true,
          isSelfTransfer: true,
          relayState: 'confirmed'
        },
        // Proved ops sweep: principal 10 / fee 2, snapshot never recorded.
        {
          txHash: TX.SWEEP,
          accountIndex: 0,
          feePiconeros: '2',
          destinations: [{ address: ADDRESS.OPS, amountPiconeros: '10' }],
          height: HEIGHT.SWEEP,
          inTxPool: false,
          isConfirmed: true,
          isRelayed: true,
          isSelfTransfer: false,
          relayState: 'confirmed'
        }
      ],
      // Explicit bridge: confirmed ledger totals never mix these in.
      bridge: {
        pendingIncoming: [
          {
            txHash: TX.BRIDGE_INCOMING,
            accountIndex: 0,
            subaddressIndex: 0,
            amountPiconeros: '4',
            inTxPool: true,
            isConfirmed: false
          }
        ],
        pendingOutgoing: [
          {
            txHash: TX.PENDING_PAYOUT,
            accountIndex: 0,
            feePiconeros: '1',
            destinations: [{ address: ADDRESS.CURATOR_ONE, amountPiconeros: '8' }],
            inTxPool: true,
            isConfirmed: false,
            isRelayed: true,
            isSelfTransfer: false,
            relayState: 'pool'
          }
        ]
      },
      // Escrow evidence: funding receipt + the two settlement transactions.
      escrow: {
        walletAddress: ADDRESS.ESCROW,
        derivation: {
          complete: true,
          primaryAddress: ADDRESS.ESCROW,
          derived: [{ majorIndex: 1, minorIndex: 0, address: ADDRESS.ESCROW_SUB }],
          mismatches: []
        },
        incoming: [
          {
            txHash: TX.FUNDING,
            accountIndex: 1,
            subaddressIndex: 0,
            amountPiconeros: '120',
            height: HEIGHT.FUNDING,
            inTxPool: false,
            isConfirmed: true
          }
        ],
        outgoing: [
          {
            txHash: TX.AWARD,
            accountIndex: 0,
            feePiconeros: '3',
            destinations: [
              { address: ADDRESS.CURATOR_ONE, amountPiconeros: '100' },
              { address: ADDRESS.COLD, amountPiconeros: '17' }
            ],
            height: HEIGHT.AWARD,
            inTxPool: false,
            isConfirmed: true,
            isRelayed: true,
            isSelfTransfer: false,
            relayState: 'confirmed'
          },
          {
            txHash: TX.ROLLOVER,
            accountIndex: 0,
            feePiconeros: '1',
            destinations: [{ address: ADDRESS.WALLET, amountPiconeros: '139' }],
            height: HEIGHT.ROLLOVER,
            inTxPool: false,
            isConfirmed: true,
            isRelayed: true,
            isSelfTransfer: false,
            relayState: 'confirmed'
          }
        ],
        bridge: { pendingIncoming: [], pendingOutgoing: [] }
      }
    },
    ledger: {
      receipts: [
        {
          // Legacy funding-time BOUNTY_FEE accrual: nominal 20, never cash.
          id: 1,
          txHash: TX.FUNDING,
          feeType: 'BOUNTY_FEE',
          walletReceipt: true,
          state: 'CONFIRMED',
          piconeros: 20n,
          rewardsPiconeros: null,
          donationRewardsPct: null,
          recipientMajor: 0,
          recipientMinor: 0,
          height: HEIGHT.FUNDING,
          confirmedAt: new Date(DATE.FUNDING),
          postId: 301,
          payInId: null
        },
        {
          // Historical nominal rollover 140; chain-verified net is 139.
          id: 2,
          txHash: TX.ROLLOVER,
          feeType: 'BOUNTY_ROLLOVER',
          walletReceipt: true,
          state: 'CONFIRMED',
          piconeros: 140n,
          rewardsPiconeros: null,
          donationRewardsPct: null,
          recipientMajor: 0,
          recipientMinor: 0,
          height: HEIGHT.ROLLOVER,
          confirmedAt: new Date(DATE.ROLLOVER),
          postId: 302,
          payInId: null
        }
      ],
      downvotes: [],
      payouts: [
        {
          id: 11,
          distributionId: 1,
          curatorId: 7,
          recipientAddress: ADDRESS.CURATOR_ONE,
          piconeros: 40n,
          txHash: TX.PAYOUT,
          state: 'CONFIRMED'
        },
        {
          id: 12,
          distributionId: 1,
          curatorId: 8,
          recipientAddress: ADDRESS.CURATOR_TWO,
          piconeros: 20n,
          txHash: TX.PAYOUT,
          state: 'SENT'
        },
        {
          // Still-open commitment whose relay attempt sits in the mempool.
          id: 13,
          distributionId: 1,
          curatorId: 9,
          recipientAddress: ADDRESS.CURATOR_ONE,
          piconeros: 8n,
          txHash: null,
          state: 'QUEUED'
        }
      ],
      distributions: [
        {
          id: 1,
          periodStart: new Date(DATE.DIST_START),
          periodEnd: new Date(DATE.DIST_END),
          poolPiconeros: 140n,
          distributedPiconeros: 60n,
          rolledOverPiconeros: 0n,
          payoutCount: 3,
          status: 'COMPLETED',
          opsInflowPiconeros: 20n,
          opsRolledOverPiconeros: 0n,
          opsAvailablePiconeros: 20n,
          opsSweptPiconeros: 0n,
          opsSweepTxHash: null,
          opsNetworkFeesAccountedPiconeros: 0n
        }
      ],
      transactions: [
        {
          network: SCOPE.network,
          walletAddress: SCOPE.walletAddress,
          txHash: TX.PAYOUT,
          kind: 'PAYOUT',
          state: 'RELAYED',
          accountIndex: 0,
          distributionId: 1,
          principalPiconeros: 60n,
          // The real fee 7 was never persisted; wallet history proves it.
          networkFeePiconeros: 0n,
          metadata: {
            payouts: [
              { payoutId: 11, recipientAddress: ADDRESS.CURATOR_ONE, piconeros: '40' },
              { payoutId: 12, recipientAddress: ADDRESS.CURATOR_TWO, piconeros: '20' }
            ]
          },
          relayAttemptedAt: new Date(DATE.ROLLOVER),
          relayedAt: new Date(DATE.ROLLOVER)
        },
        {
          network: SCOPE.network,
          walletAddress: SCOPE.walletAddress,
          txHash: TX.CONSOLIDATION,
          kind: 'CONSOLIDATION',
          state: 'RELAYED',
          accountIndex: 1,
          distributionId: 1,
          principalPiconeros: 0n,
          networkFeePiconeros: 3n,
          metadata: { destination: ADDRESS.WALLET, selfTransfer: true },
          relayAttemptedAt: new Date(DATE.ROLLOVER),
          relayedAt: new Date(DATE.ROLLOVER)
        },
        {
          network: SCOPE.network,
          walletAddress: SCOPE.walletAddress,
          txHash: TX.SWEEP,
          kind: 'OPS_SWEEP',
          state: 'RELAYED',
          accountIndex: 0,
          distributionId: 1,
          principalPiconeros: 10n,
          networkFeePiconeros: 2n,
          metadata: { destination: ADDRESS.OPS },
          relayAttemptedAt: new Date(DATE.ROLLOVER),
          relayedAt: new Date(DATE.ROLLOVER)
        },
        {
          // Pending relay attempt: PREPARED + attempted, mempool evidence.
          network: SCOPE.network,
          walletAddress: SCOPE.walletAddress,
          txHash: TX.PENDING_PAYOUT,
          kind: 'PAYOUT',
          state: 'PREPARED',
          accountIndex: 0,
          distributionId: 1,
          principalPiconeros: 8n,
          networkFeePiconeros: 1n,
          metadata: {
            payouts: [{ payoutId: 13, recipientAddress: ADDRESS.CURATOR_ONE, piconeros: '8' }]
          },
          relayAttemptedAt: new Date(DATE.ROLLOVER),
          relayedAt: null
        }
      ],
      bountyPayments: [
        {
          // Award whose post-relay settlement metadata was never persisted.
          id: 21,
          itemId: 301,
          piconeros: 100n,
          feePiconeros: 20n,
          recipientAddress: ADDRESS.CURATOR_ONE,
          kind: 'AWARD',
          txHash: TX.AWARD,
          feeTxHash: null,
          state: 'CONFIRMED',
          feeRecipientAddress: null,
          networkFeePiconeros: null,
          recipientReceivedPiconeros: null,
          feeReceivedPiconeros: null,
          feeSettlementNetworkFeePiconeros: null
        },
        {
          // Rollover: net 139 arrived after the escrow miner fee 1.
          id: 22,
          itemId: 302,
          piconeros: 140n,
          feePiconeros: 0n,
          recipientAddress: ADDRESS.WALLET,
          kind: 'ROLLOVER',
          txHash: TX.ROLLOVER,
          feeTxHash: null,
          state: 'CONFIRMED',
          feeRecipientAddress: null,
          networkFeePiconeros: null,
          recipientReceivedPiconeros: null,
          feeReceivedPiconeros: null,
          feeSettlementNetworkFeePiconeros: null
        }
      ],
      items: [
        { id: 301, bountyPiconeros: 0n, bountyFeePiconeros: 20n },
        { id: 302, bountyPiconeros: 100n }
      ],
      // Funding evidence for the mandated identification predicate: the legacy
      // funding-time BOUNTY_FEE row (id 1) is tied to this ObservedBounty's
      // funding transaction. The migration itself carries no reference, so the
      // repair manifest re-derives the same relationship from these rows.
      observedBounties: [
        { id: 401, txHash: TX.FUNDING, postId: 301, paymentId: 'fixture301' }
      ],
      observedBountyReceipts: [],
      earns: [
        { id: 501, userId: 7, distributionId: 1, piconeros: 40n },
        { id: 502, userId: 8, distributionId: 1, piconeros: 20n }
      ]
    },
    decisions: { receipts: {} },
    config: {
      downvoteRewardsPct: 100,
      postingFeeRewardsPct: 70,
      territoryFeeRewardsPct: 30,
      boostRewardsPct: 30,
      walletlessTipRewardsPct: 70
    },
    reserve: { feeHeadroomPiconeros: 1000000000n, dustFloorPiconeros: 1000000000n }
  }
  if (classifyIncoming) {
    input.decisions.receipts[TX.INCOMING] = approvedIncomingClassification()
  }
  return input
}
