/* eslint-env jest */

import { ed25519 } from '@noble/curves/ed25519'
import { base58xmr } from '@scure/base'
import { keccak256 } from 'js-sha3'
import { oneTimeOutputKey, senderPublicPart } from '@/api/monero/paymentKeyStructure'

// Deterministic, throwaway synthetic fixtures for the Finding #1 payment-proof
// codec, envelope, store, chain adapter and verifier tasks (Task 1 fixture
// contract). Everything is derived from the small deterministic scalars
// 1..20 on the ed25519 base point: no real secrets, keys, addresses, wallet
// history or transaction hashes exist anywhere in this file.
//
// One synthetic payment is modeled by all three builders, always arithmetically
// closed around D = 100 piconeros with network fee F = 7:
//
//   default payout:   D(100) = external A(40) + change(33) + external B(20) + F(7)
//   ownedAmount 22:   D(100) = external A(40) + change(22) + external B(20) + hidden(11) + F(7)
//
// `paymentFixture` returns a complete valid PaymentClaimsV1 input;
// `paymentTxFixture` returns a fake built-transaction object (SDK-shaped
// getters) plus a ProofPayloadV1-shaped `proofPayload`; `paymentChainFixture`
// returns private scanned/raw chain facts (fake wallet/daemon + plain session)
// for the later adapter/verifier tasks. Later tasks own their local helpers
// (`fakeWalletFor`, `keyProvider`, ...) — this module only carries shared
// deterministic facts.
//
// Scalar allocation (all points `scalar * ed25519 base`):
//   1/2 recipient A keys, 3/4 recipient B keys, 5/6 wallet primary keys,
//   7/8 hidden-extra recipient keys — these doubles are BOTH the public keys
//   (point(n)) and the corresponding SECRET scalars n, so the sender-side and
//   receiver-side one-time-key arithmetic below is real math, not decoration.
//   9 (REPLACED) the source output key is now derived; 10–13 (REPLACED) the
//   audited output keys are now derived; 14 source key image, 15 change key
//   image, 16–19 (REPLACED) tx key slots are now derived,
//   20 spare spend-output stealth key (an output this wallet does NOT own),
//   101 tx main SECRET r (public = 101*G), 102..105 per-output tx secrets
//   r_i (output order: externalA, change, externalB, hiddenExtra),
//   106 source coinbase tx main secret,
//   31/32..39/40 spend/view key pairs of derived account primaries 1..5.
//
// The captured key bundle is the SECRET-bundle STRING the installed SDK's
// `MoneroTx.getKey()` returns: the little-endian main secret followed by the
// ordered additional per-output secrets (exactly one additional secret per
// chain output), NOT an object of public keys (final-review C1).
//
// All addresses are checksum-valid and curve-valid on MAINNET (18/19/42) and
// STAGENET (24/25/36).

const APPLICATION = 'stashernews/monero/payment'
const PAYMENT_ID = 'a1b2c3d4e5f60718'
const D_PICONEROS = 100n
const DEFAULT_TX_HASH = 'f1'.repeat(32)
const DEFAULT_DISPATCH_ID = '00000000-0000-4000-8000-000000000001'
const DEFAULT_OBSERVED_AT = '2026-10-06T12:00:00.000Z'
const SOURCE_TX_HASH = 'e1'.repeat(32)
const SPEND_TX_HASH = 'e2'.repeat(32)
const BOUNDARY = Object.freeze({ height: 3000000, blockHash: 'd4'.repeat(32) })
const AUDITED_HEIGHT = 2999980
const SOURCE_HEIGHT = 2999000
const SPEND_HEIGHT = 2999999
const SOURCE_GLOBAL_INDEX = 690
const DEFAULT_GLOBAL_INDEX = 918
const DEFAULT_LOCAL_INDEX = 1
const DEFAULT_OWNED_AMOUNT = 33n
const NETWORK_TYPES = Object.freeze({ MAINNET: 0, STAGENET: 2 })
const PREFIXES = Object.freeze({
  MAINNET: Object.freeze({ PRIMARY: 18, INTEGRATED: 19, SUBADDRESS: 42 }),
  STAGENET: Object.freeze({ PRIMARY: 24, INTEGRATED: 25, SUBADDRESS: 36 })
})

const point = scalar => Buffer.from(ed25519.ExtendedPoint.BASE.multiply(BigInt(scalar)).toRawBytes()).toString('hex')

// 64-hex little-endian secret-scalar encoding (the SDK key-bundle string form).
export const leHex = scalar => {
  let hex = BigInt(scalar).toString(16)
  if (hex.length % 2) hex = `0${hex}`
  return Buffer.from(hex.padStart(64, '0'), 'hex').reverse().toString('hex')
}

// Convenience for other suites' fake built transactions: a format-valid
// SECRET-bundle string (main + `additionalCount` additional little-endian
// scalars) derived from a per-suite seed. Every slot is a valid
// 0 < s < curve-order scalar; suites that need output CORRESPONDENCE derive
// it explicitly (see deriveTxKeys below).
export const secretBundleHex = (keySeed, additionalCount) =>
  leHex(keySeed) +
  Array.from({ length: additionalCount }, (_, index) => leHex(BigInt(keySeed) + BigInt(index) + 1n)).join('')

// A one-time output key OWNED by the fixture wallet at the given derived
// position (receiver a*R path, a = wallet view secret 6), paying
// `slotScalar`'s standard slot key — for hand-built raw records that must
// satisfy the collector's raw ownership enumeration.
export const ownedVoutForPosition = ({ majorIndex, slotScalar, outputIndex }) => oneTimeOutputKey({
  publicKey: senderPublicPart(slotScalar, null),
  secret: leHex(WALLET_VIEW_SECRET),
  publicSpend: majorIndex === 0 ? KEYS.wallet.spendKey : ACCOUNT_PRIMARY_KEYS[majorIndex].spendKey,
  outputIndex
})

// Secret tx keys: main r + one additional secret PER OUTPUT SLOT (output
// order fixed by arrangeOutputs below).
const TX_MAIN_SECRET = 101n
const OUTPUT_SECRETS = Object.freeze({ externalA: 102n, change: 103n, externalB: 104n, hiddenExtra: 105n })
const SOURCE_TX_SECRET = 106n
// The wallet's private view key a is scalar 6 (its public view key is point(6)):
// the receiver a*R path for owned/change outputs is real arithmetic here.
const WALLET_VIEW_SECRET = 6n

const KEYS = Object.freeze({
  recipientA: Object.freeze({ spendKey: point(1), viewKey: point(2) }),
  recipientB: Object.freeze({ spendKey: point(3), viewKey: point(4) }),
  wallet: Object.freeze({ spendKey: point(5), viewKey: point(6) }),
  hiddenExtra: Object.freeze({ spendKey: point(7), viewKey: point(8) })
})
const ACCOUNT_PRIMARY_KEYS = Object.freeze({
  1: Object.freeze({ spendKey: point(31), viewKey: point(32) }),
  2: Object.freeze({ spendKey: point(33), viewKey: point(34) }),
  3: Object.freeze({ spendKey: point(35), viewKey: point(36) }),
  4: Object.freeze({ spendKey: point(37), viewKey: point(38) }),
  5: Object.freeze({ spendKey: point(39), viewKey: point(40) })
})
const STEALTH = Object.freeze({
  spendOutput: point(20)
})
const KEY_IMAGES = Object.freeze({ source: point(14), change: point(15) })

function encodeAddress ({ network, type, spendKey, viewKey, paymentId = null }) {
  const prefix = PREFIXES[network][type]
  const body = new Uint8Array(type === 'INTEGRATED' ? 73 : 65)
  body[0] = prefix
  body.set(Buffer.from(spendKey, 'hex'), 1)
  body.set(Buffer.from(viewKey, 'hex'), 33)
  if (type === 'INTEGRATED') body.set(Buffer.from(paymentId, 'hex'), 65)
  const checksum = Buffer.from(keccak256(body), 'hex').subarray(0, 4)
  return base58xmr.encode(new Uint8Array([...body, ...checksum]))
}

function buildAddresses (network) {
  return Object.freeze({
    recipientA: encodeAddress({ network, type: 'PRIMARY', ...KEYS.recipientA }),
    recipientAlias: encodeAddress({ network, type: 'INTEGRATED', ...KEYS.recipientA, paymentId: PAYMENT_ID }),
    recipientB: encodeAddress({ network, type: 'SUBADDRESS', ...KEYS.recipientB }),
    wallet: encodeAddress({ network, type: 'PRIMARY', ...KEYS.wallet }),
    hiddenExtra: encodeAddress({ network, type: 'PRIMARY', ...KEYS.hiddenExtra }),
    accountPrimary: Object.freeze(Object.fromEntries(
      Object.entries(ACCOUNT_PRIMARY_KEYS).map(([major, keys]) =>
        [major, encodeAddress({ network, type: 'PRIMARY', ...keys })])
    ))
  })
}

const ADDRESSES = Object.freeze({ MAINNET: buildAddresses('MAINNET'), STAGENET: buildAddresses('STAGENET') })

const identityFor = (network, keys) => `${network}/${keys.spendKey}/${keys.viewKey}`

const PAYMENT_OVERRIDE_KEYS = new Set([
  'network', 'repeatedRecipient', 'feeSubtractedFromLast', 'txHash', 'dispatchId',
  'journalRole', 'kind', 'scope', 'sourceAccounts', 'distributionId',
  'bountyPaymentId', 'itemId', 'principalPiconeros', 'networkFeePiconeros',
  'frozenTerms', 'ownedTargets', 'change', 'members', 'receivingAggregates',
  'feePolicy', 'localIndex', 'populatedPublicKeys'
])
const CHAIN_EXTRA_OVERRIDE_KEYS = ['ownedAmount', 'globalIndex', 'spentOwnedOutput']

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

function deriveReceivingAggregates (members) {
  const totals = new Map()
  for (const member of members) {
    totals.set(member.receivingIdentity, (totals.get(member.receivingIdentity) ?? 0n) + BigInt(member.actualPiconeros))
  }
  return [...totals.entries()]
    .map(([receivingIdentity, amountPiconeros]) => ({ receivingIdentity, amountPiconeros: amountPiconeros.toString() }))
    .sort((a, b) => (a.receivingIdentity < b.receivingIdentity ? -1 : a.receivingIdentity > b.receivingIdentity ? 1 : 0))
}

function deriveFeePolicy (members, mode) {
  return {
    mode,
    legs: members.map(member => ({
      memberId: member.id,
      leg: member.leg,
      grossPiconeros: member.grossPiconeros,
      actualPiconeros: member.actualPiconeros
    }))
  }
}

function withFeeSubtraction (members, feePiconeros) {
  if (members.length === 0) return members
  if (typeof feePiconeros !== 'string' || !/^(0|[1-9][0-9]*)$/.test(feePiconeros)) return members
  const fee = BigInt(feePiconeros)
  const out = members.map(member => ({ ...member }))
  const last = out[out.length - 1]
  last.actualPiconeros = (BigInt(last.grossPiconeros) - fee).toString()
  return out
}

function defaultMembers ({ network, addresses, repeatedRecipient, feeSubtractedFromLast, networkFeePiconeros }) {
  const identityA = identityFor(network, KEYS.recipientA)
  const identityB = identityFor(network, KEYS.recipientB)
  const members = [
    {
      id: '11',
      leg: 'PRINCIPAL',
      address: addresses.recipientA,
      type: 'PRIMARY',
      paymentId: null,
      receivingIdentity: identityA,
      grossPiconeros: '40',
      actualPiconeros: '40'
    },
    repeatedRecipient
      ? {
          id: '12',
          leg: 'PRINCIPAL',
          address: addresses.recipientAlias,
          type: 'INTEGRATED',
          paymentId: PAYMENT_ID,
          receivingIdentity: identityA,
          grossPiconeros: '20',
          actualPiconeros: '20'
        }
      : {
          id: '12',
          leg: 'PRINCIPAL',
          address: addresses.recipientB,
          type: 'SUBADDRESS',
          paymentId: null,
          receivingIdentity: identityB,
          grossPiconeros: '20',
          actualPiconeros: '20'
        }
  ]
  return feeSubtractedFromLast ? withFeeSubtraction(members, networkFeePiconeros) : members
}

// Resolve the shared synthetic-payment state from recognized overrides.
// Unknown override keys throw so a typo can never produce a silently weaker
// fixture.
function resolveFixture (overrides, extraKeys) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('payment proof fixture: overrides must be an object')
  }
  for (const key of Object.keys(overrides)) {
    if (!PAYMENT_OVERRIDE_KEYS.has(key) && !extraKeys.includes(key)) {
      throw new Error(`payment proof fixture: unrecognized override ${key}`)
    }
  }

  const network = overrides.network ?? 'STAGENET'
  if (network !== 'MAINNET' && network !== 'STAGENET') {
    throw new Error('payment proof fixture: network must be MAINNET or STAGENET')
  }
  const addresses = ADDRESSES[network]
  const repeatedRecipient = overrides.repeatedRecipient ?? false
  const feeSubtractedFromLast = overrides.feeSubtractedFromLast ?? false
  const networkFeePiconeros = has(overrides, 'networkFeePiconeros') ? overrides.networkFeePiconeros : '7'
  const members = has(overrides, 'members')
    ? overrides.members
    : defaultMembers({ network, addresses, repeatedRecipient, feeSubtractedFromLast, networkFeePiconeros })
  const principalPiconeros = has(overrides, 'principalPiconeros') ? overrides.principalPiconeros : '60'
  const journalRole = has(overrides, 'journalRole') ? overrides.journalRole : 'REWARDS'
  const localIndex = has(overrides, 'localIndex') ? overrides.localIndex : DEFAULT_LOCAL_INDEX
  if (!Number.isInteger(localIndex) || localIndex < 0 || localIndex > 2) {
    throw new Error('payment proof fixture: localIndex must be an integer in 0..2')
  }

  const feePolicy = has(overrides, 'feePolicy')
    ? overrides.feePolicy
    : deriveFeePolicy(members, feeSubtractedFromLast ? 'SUBTRACT_LAST' : 'NONE')
  const aggregates = has(overrides, 'receivingAggregates')
    ? overrides.receivingAggregates
    : deriveReceivingAggregates(members)

  return {
    network,
    addresses,
    repeatedRecipient,
    feeSubtractedFromLast,
    localIndex,
    populatedPublicKeys: overrides.populatedPublicKeys === true,
    members,
    feePolicy,
    aggregates,
    networkFeePiconeros,
    principalPiconeros,
    txHash: has(overrides, 'txHash') ? overrides.txHash : DEFAULT_TX_HASH,
    dispatchId: has(overrides, 'dispatchId') ? overrides.dispatchId : DEFAULT_DISPATCH_ID,
    journalRole,
    kind: has(overrides, 'kind') ? overrides.kind : 'PAYOUT',
    scope: has(overrides, 'scope') ? overrides.scope : { network, walletAddress: addresses.wallet },
    sourceAccounts: has(overrides, 'sourceAccounts') ? overrides.sourceAccounts : ['0'],
    distributionId: has(overrides, 'distributionId') ? overrides.distributionId : (journalRole === 'ESCROW' ? null : '1'),
    bountyPaymentId: has(overrides, 'bountyPaymentId') ? overrides.bountyPaymentId : null,
    itemId: has(overrides, 'itemId') ? overrides.itemId : null,
    frozenTerms: has(overrides, 'frozenTerms') ? overrides.frozenTerms : null,
    ownedTargets: has(overrides, 'ownedTargets') ? overrides.ownedTargets : [],
    change: has(overrides, 'change') ? overrides.change : { accountIndex: '0', subaddressIndex: '0', address: addresses.wallet }
  }
}

/**
 * Deterministic complete PaymentClaimsV1 input. Recognized overrides:
 * `network` ('MAINNET'|'STAGENET'), `repeatedRecipient`,
 * `feeSubtractedFromLast`, `localIndex` (0..2), `txHash`, `dispatchId`,
 * `journalRole`, `kind`, `scope`, `sourceAccounts`, `distributionId`,
 * `bountyPaymentId`, `itemId`, `principalPiconeros`, `networkFeePiconeros`,
 * `frozenTerms`, `ownedTargets`, `change`, `members`, `receivingAggregates`,
 * `feePolicy`. Unknown overrides throw.
 *
 * @param {object} [overrides]
 * @returns {object} PaymentClaimsV1 input (not yet normalized)
 */
export function paymentFixture (overrides = {}) {
  const state = resolveFixture(overrides, [])
  return {
    application: APPLICATION,
    bindingVersion: '1',
    captureContractVersion: '1',
    dispatchId: state.dispatchId,
    journalRole: state.journalRole,
    scope: { network: state.scope.network, walletAddress: state.scope.walletAddress },
    txHash: state.txHash,
    kind: state.kind,
    sourceAccounts: [...state.sourceAccounts],
    distributionId: state.distributionId,
    bountyPaymentId: state.bountyPaymentId,
    itemId: state.itemId,
    networkFeePiconeros: state.networkFeePiconeros,
    principalPiconeros: state.principalPiconeros,
    frozenTerms: state.frozenTerms,
    feePolicy: state.feePolicy,
    members: state.members.map(member => ({ ...member })),
    receivingAggregates: state.aggregates.map(aggregate => ({ ...aggregate })),
    ownedTargets: state.ownedTargets,
    change: state.change
  }
}

// Place the change output at `localIndex` among the built outputs; external
// destinations keep their relative order. `withHiddenExtra` appends the
// unclaimed extra output the residual scenarios need.
function arrangeOutputs (localIndex, withHiddenExtra = false) {
  const outputs = [
    { kind: 'externalA' },
    { kind: 'externalB' }
  ]
  outputs.splice(localIndex, 0, { kind: 'change' })
  if (withHiddenExtra) outputs.push({ kind: 'hiddenExtra' })
  return outputs
}

// Real sender/receiver arithmetic: the tx public key slots and one-time
// output keys are DERIVED from the fixture secrets and the recipients' PUBLIC
// keys, exactly as the verifier's kind-aware rules re-derive them:
//   externalA (standard)  slot = r_0*G            vout = Hs(8*r_0*slot||i)*G + A_spend
//   change (owned)        slot = r_1*G            vout = Hs(8*a*slot||i)*G + wallet_spend (a = 6)
//   externalB (subaddress) slot = r_2*B_B         vout = Hs(8*r_2*slot||i)*G + B_spend
//   hiddenExtra (standard) slot = r_3*G           vout = Hs(8*r_3*slot||i)*G + hidden_spend
function deriveTxKeys (outputs) {
  const slotPublicKeys = outputs.map(output => {
    const secret = OUTPUT_SECRETS[output.kind]
    return output.kind === 'externalB'
      ? senderPublicPart(secret, KEYS.recipientB.spendKey)
      : senderPublicPart(secret, null)
  })
  const outputKeys = outputs.map((output, index) => {
    const secret = OUTPUT_SECRETS[output.kind]
    if (output.kind === 'change') {
      // Owned/change output: the RECEIVER path a*R with a = wallet view
      // secret 6, R = this output's slot key.
      return oneTimeOutputKey({
        publicKey: slotPublicKeys[index],
        secret: leHex(WALLET_VIEW_SECRET),
        publicSpend: KEYS.wallet.spendKey,
        outputIndex: index
      })
    }
    // External outputs: the SENDER path Hs(8*r_i*A || i)*G + B with A the
    // recipient's PUBLIC view key.
    const recipient = output.kind === 'externalA'
      ? KEYS.recipientA
      : output.kind === 'externalB' ? KEYS.recipientB : KEYS.hiddenExtra
    return oneTimeOutputKey({
      publicKey: recipient.viewKey,
      secret: leHex(secret),
      publicSpend: recipient.spendKey,
      outputIndex: index
    })
  })
  const mainPublicKey = senderPublicPart(TX_MAIN_SECRET, null)
  const additionalPublicKeys = [...slotPublicKeys]
  const keyBundleHex = leHex(TX_MAIN_SECRET) + outputs.map(output => leHex(OUTPUT_SECRETS[output.kind])).join('')
  return { mainPublicKey, additionalPublicKeys, outputKeys, keyBundleHex, additionalKeyCount: outputs.length }
}

function memberForLeg (members, leg) {
  const member = members.find(candidate => candidate.id === leg.memberId && candidate.leg === leg.leg)
  if (!member) throw new Error(`payment proof fixture: fee-policy leg ${leg.memberId}/${leg.leg} has no member`)
  return member
}

/**
 * Deterministic fake built transaction: same hash, real fee, actual
 * post-subtraction destinations and ordered keys/change as `paymentFixture`,
 * exposed through SDK-shaped getters, plus a ProofPayloadV1-shaped
 * `proofPayload` for the envelope task. `getKey()` returns the SECRET-bundle
 * STRING the installed SDK captures (main secret + one additional secret per
 * output, little-endian hex — final-review C1). The payload's public
 * built-structure fields default to explicit null (the SDK does not expose
 * them); pass `populatedPublicKeys: true` to opt into the populated variant.
 * Accepts the same overrides as `paymentFixture`.
 *
 * @param {object} [overrides]
 * @returns {object} fake built tx with `proofPayload`
 */
export function paymentTxFixture (overrides = {}) {
  const state = resolveFixture(overrides, [])
  const fee = BigInt(state.networkFeePiconeros)
  const destinations = state.feePolicy.legs.map(leg => {
    const member = memberForLeg(state.members, leg)
    return { address: member.address, amountPiconeros: BigInt(leg.actualPiconeros) }
  })
  const externalTotal = destinations.reduce((sum, destination) => sum + destination.amountPiconeros, 0n)
  const changeAmountPiconeros = state.change === null ? 0n : D_PICONEROS - fee - externalTotal
  if (changeAmountPiconeros < 0n) throw new Error('payment proof fixture: change amount would be negative')
  const outputs = arrangeOutputs(state.localIndex)
  const derived = deriveTxKeys(outputs)
  const changeAddress = state.change === null ? null : state.change.address
  // Payloads use explicit null; unavailable SDK getters return undefined.
  const changeAmountExposed = changeAddress === null ? null : changeAmountPiconeros

  const populated = state.populatedPublicKeys
  const proofPayload = {
    payloadVersion: '1',
    keyBundleHex: derived.keyBundleHex,
    additionalKeyCount: derived.additionalKeyCount,
    builtStructure: {
      txHash: state.txHash,
      networkFeePiconeros: String(fee),
      actualDestinations: destinations.map(destination => ({
        address: destination.address,
        amountPiconeros: destination.amountPiconeros.toString()
      })),
      changeAddress,
      changeAmountPiconeros: changeAddress === null ? null : changeAmountPiconeros.toString(),
      mainPublicKey: populated ? derived.mainPublicKey : null,
      additionalPublicKeys: populated ? [...derived.additionalPublicKeys] : null,
      outputKeys: populated ? [...derived.outputKeys] : null
    }
  }

  return {
    txHash: state.txHash,
    networkFeePiconeros: fee,
    actualDestinations: destinations,
    changeAddress,
    changeAmountPiconeros: changeAmountExposed,
    mainPublicKey: derived.mainPublicKey,
    additionalPublicKeys: derived.additionalPublicKeys,
    outputKeys: derived.outputKeys,
    additionalKeyCount: derived.additionalKeyCount,
    keyBundleHex: derived.keyBundleHex,
    proofPayload,
    getHash: () => state.txHash,
    getFee: () => fee,
    getOutgoingTransfer: () => ({
      getDestinations: () => destinations.map(destination => ({
        getAddress: () => destination.address,
        getAmount: () => destination.amountPiconeros
      }))
    }),
    getChangeAddress: () => changeAddress ?? undefined,
    getChangeAmount: () => changeAmountExposed ?? undefined,
    // The installed SDK's MoneroTx.getKey() is a string of concatenated
    // little-endian SECRET scalars: main first, then one per output.
    getKey: () => derived.keyBundleHex,
    // Optional populated public facts (the test opt-in path — the real SDK
    // does not expose these on a built tx): readBuiltTx validates them as
    // canonical points when present and never requires bundle equality.
    ...(populated
      ? {
          getMainPublicKey: () => derived.mainPublicKey,
          getAdditionalPublicKeys: () => [...derived.additionalPublicKeys],
          getOutputKeys: () => [...derived.outputKeys]
        }
      : {})
  }
}

function parseOwnedAmount (value) {
  if (value === undefined) return DEFAULT_OWNED_AMOUNT
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error('payment proof fixture: ownedAmount must not be negative')
    return value
  }
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value)
  throw new Error('payment proof fixture: ownedAmount must be a non-negative bigint or canonical decimal string')
}

function fakeWalletOutput (row) {
  return {
    getTx: () => ({ getHash: () => row.txHash, getHeight: () => row.blockHeight }),
    getAccountIndex: () => row.accountIndex,
    getSubaddressIndex: () => row.subaddressIndex,
    // Deliberately the chain-global index, NOT the local vout position: the
    // collector must join owned outputs through raw vout keys, never SDK
    // getIndex().
    getIndex: () => row.globalIndex,
    getAmount: () => row.amountPiconeros,
    getStealthPublicKey: () => row.stealthPublicKey,
    getKeyImage: () => ({ getHex: () => row.keyImage }),
    getIsSpent: () => row.isSpent,
    getIsFrozen: () => false,
    getIsLocked: () => false
  }
}

function fakeCheck (receipt) {
  return {
    getIsGood: () => receipt !== null,
    getReceivedAmount: () => (receipt === null ? 0n : receipt.amountPiconeros),
    getInTxPool: () => false,
    getNumConfirmations: () => (receipt === null ? 0 : receipt.confirmations)
  }
}

const readAddressText = address => {
  if (typeof address === 'string') return address
  if (address && typeof address.getAddress === 'function') return address.getAddress()
  return null
}

/**
 * Deterministic private chain-scan fixture for the adapter/verifier tasks.
 * Base independent facts: D=100n scanned into one source account, O=33n owned
 * outputs (O=22n with `ownedAmount: 22n`, leaving the exact 11n hidden-extra
 * residual), F=7n exact raw fee and E=60n external receipts verified through
 * the fake `checkTxKey`. Recognized overrides: `ownedAmount`
 * (bigint|canonical string), `globalIndex`, `spentOwnedOutput`, plus every
 * `paymentFixture` override.
 *
 * @param {object} [overrides]
 * @returns {object} fixture facts; see the Task 1 report for the full shape.
 *   Task 5 additive extension: `session.checkTxKey` (same jest.fn as
 *   `wallet.checkTxKey`) so verification sessions carry the receipt checker.
 */
export function paymentChainFixture (overrides = {}) {
  const state = resolveFixture(overrides, CHAIN_EXTRA_OVERRIDE_KEYS)
  const fee = BigInt(state.networkFeePiconeros)
  const ownedAmount = parseOwnedAmount(overrides.ownedAmount)
  const globalIndex = overrides.globalIndex ?? DEFAULT_GLOBAL_INDEX
  if (!Number.isInteger(globalIndex) || globalIndex < state.localIndex) {
    throw new Error('payment proof fixture: globalIndex must be a safe integer at least localIndex')
  }
  const spentOwnedOutput = overrides.spentOwnedOutput ?? false
  if (typeof spentOwnedOutput !== 'boolean') {
    throw new Error('payment proof fixture: spentOwnedOutput must be a boolean')
  }

  const outputs = arrangeOutputs(state.localIndex).map(output => ({ ...output }))
  // The chain fixture models the default two-destination payout; a custom leg
  // structure cannot be projected onto its fixed synthetic output layout.
  if (state.feePolicy.legs.length !== 2) {
    throw new Error('payment proof fixture: paymentChainFixture models the default two-destination payout')
  }
  // Amount per output kind, derived from the claims destination legs.
  const externalAmounts = state.feePolicy.legs.map(leg => BigInt(leg.actualPiconeros))
  const externalReceipts = state.feePolicy.legs.map((leg, index) => {
    const member = memberForLeg(state.members, leg)
    return {
      address: member.address,
      amountPiconeros: externalAmounts[index],
      confirmations: BOUNDARY.height - AUDITED_HEIGHT + 1,
      inTxPool: false
    }
  })
  const externalTotal = externalAmounts.reduce((sum, amount) => sum + amount, 0n)
  const hiddenExtraAmount = D_PICONEROS - fee - externalTotal - ownedAmount
  if (hiddenExtraAmount < 0n) {
    throw new Error('payment proof fixture: ownedAmount exceeds the synthetic input after fee and external amounts')
  }

  for (const output of outputs) {
    output.amountPiconeros = output.kind === 'change'
      ? ownedAmount
      : externalAmounts.shift()
  }
  if (hiddenExtraAmount > 0n) {
    outputs.push({ kind: 'hiddenExtra', amountPiconeros: hiddenExtraAmount })
  }
  // Final layout fixed: derive the tx key slots and vouts from the complete
  // output list (exactly one additional secret per chain output).
  const auditedKeys = deriveTxKeys(outputs)
  for (let index = 0; index < outputs.length; index++) {
    outputs[index].stealthPublicKey = auditedKeys.outputKeys[index]
  }
  const hiddenExtraVout = hiddenExtraAmount > 0n ? auditedKeys.outputKeys[outputs.length - 1] : null

  const baseIndex = globalIndex - state.localIndex
  const outputIndices = outputs.map((output, index) => baseIndex + index)

  // The source coinbase tx: its main tx key and its single output are derived
  // from the wallet's own view secret so the sender-side raw enumeration
  // finds it owned at (0,0) exactly like the SDK scan does.
  const sourceMainKey = senderPublicPart(SOURCE_TX_SECRET, null)
  const sourceVout = oneTimeOutputKey({
    publicKey: sourceMainKey,
    secret: leHex(WALLET_VIEW_SECRET),
    publicSpend: KEYS.wallet.spendKey,
    outputIndex: 0
  })

  const audited = {
    txHash: state.txHash,
    feePiconeros: fee,
    inputKeyImages: [KEY_IMAGES.source],
    voutKeys: outputs.map(output => output.stealthPublicKey),
    outputIndices,
    blockHeight: AUDITED_HEIGHT,
    confirmations: BOUNDARY.height - AUDITED_HEIGHT + 1,
    inTxPool: false,
    isCoinbase: false,
    mainPublicKey: auditedKeys.mainPublicKey,
    additionalPublicKeys: [...auditedKeys.additionalPublicKeys]
  }
  const source = {
    txHash: SOURCE_TX_HASH,
    feePiconeros: 0n,
    inputKeyImages: [],
    keyImage: KEY_IMAGES.source,
    voutKeys: [sourceVout],
    outputIndices: [SOURCE_GLOBAL_INDEX],
    blockHeight: SOURCE_HEIGHT,
    confirmations: BOUNDARY.height - SOURCE_HEIGHT + 1,
    inTxPool: false,
    isCoinbase: true,
    mainPublicKey: sourceMainKey,
    additionalPublicKeys: []
  }
  const spend = spentOwnedOutput
    ? {
        txHash: SPEND_TX_HASH,
        feePiconeros: 1n,
        inputKeyImages: [KEY_IMAGES.change],
        voutKeys: [STEALTH.spendOutput],
        outputIndices: [globalIndex + 100],
        blockHeight: SPEND_HEIGHT,
        confirmations: BOUNDARY.height - SPEND_HEIGHT + 1,
        inTxPool: false,
        isCoinbase: false,
        mainPublicKey: null,
        additionalPublicKeys: []
      }
    : null

  const sourceRow = {
    txHash: SOURCE_TX_HASH,
    accountIndex: 0,
    subaddressIndex: 0,
    outputIndex: 0,
    blockHeight: SOURCE_HEIGHT,
    globalIndex: SOURCE_GLOBAL_INDEX,
    amountPiconeros: D_PICONEROS,
    stealthPublicKey: sourceVout,
    keyImage: KEY_IMAGES.source,
    isSpent: true
  }
  const changeRow = {
    txHash: state.txHash,
    accountIndex: 0,
    subaddressIndex: 0,
    outputIndex: state.localIndex,
    blockHeight: AUDITED_HEIGHT,
    globalIndex,
    amountPiconeros: ownedAmount,
    stealthPublicKey: outputs[state.localIndex].stealthPublicKey,
    keyImage: KEY_IMAGES.change,
    isSpent: spentOwnedOutput
  }

  const rawByHash = {
    [state.txHash]: audited,
    [SOURCE_TX_HASH]: source,
    ...(spend === null ? {} : { [SPEND_TX_HASH]: spend })
  }
  // Task 5 fix I1 (additive): raw records carry the daemon-resolved block
  // hash. The fake daemon's getBlockHashByHeight answers BOUNDARY.blockHash
  // for every height, so the records carry exactly that value — the same
  // value its getPaymentTransactions attaches per distinct height.
  for (const record of Object.values(rawByHash)) {
    record.blockHash = BOUNDARY.blockHash
  }
  const scanRows = [fakeWalletOutput(changeRow), fakeWalletOutput(sourceRow)]
  const checkTxKey = jest.fn(async (txHash, txKey, address) => {
    const text = readAddressText(address)
    return fakeCheck(externalReceipts.find(receipt => receipt.address === text) ?? null)
  })
  // Sender-side raw-ownership enumeration support (final-review I2): the
  // ephemeral view access (private view key a = 6) plus the DERIVED address
  // per domain position (primary + account primaries 1..5). The derived
  // spend keys are the fixture account pairs, so address↔position mapping is
  // independently checkable, not just SDK-reported.
  const addressByPosition = new Map([
    ['0:0', state.scope.walletAddress],
    ...Object.entries(state.addresses.accountPrimary).map(([major, address]) => [`${major}:0`, address])
  ])
  const accountList = [0, 1, 2, 3, 4, 5].map(major => ({
    getIndex: () => major,
    getPrimaryAddress: () => addressByPosition.get(`${major}:0`)
  }))
  const wallet = {
    getOutputs: jest.fn(async () => [...scanRows]),
    getAccounts: jest.fn(async () => [...accountList]),
    getPrimaryAddress: jest.fn(async () => state.scope.walletAddress),
    getNetworkType: jest.fn(async () => NETWORK_TYPES[state.network]),
    getPrivateViewKey: jest.fn(async () => leHex(WALLET_VIEW_SECRET)),
    getAddress: jest.fn(async (majorIndex, subaddressIndex) =>
      addressByPosition.get(`${majorIndex}:${subaddressIndex}`) ?? null),
    checkTxKey,
    // The production runtime recovery treats getHeight as a SCANNED BLOCK
    // COUNT and the daemon getHeight as the chain LENGTH (boundary = length
    // − 1): cover the boundary block and keep the implied tip coherent.
    getHeight: jest.fn(async () => BOUNDARY.height + 1)
  }
  const viewWallet = {
    getOutputs: jest.fn(async () => [...scanRows]),
    getAccounts: jest.fn(async () => [...accountList]),
    getPrimaryAddress: jest.fn(async () => state.scope.walletAddress),
    getNetworkType: jest.fn(async () => NETWORK_TYPES[state.network]),
    getPrivateViewKey: jest.fn(async () => leHex(WALLET_VIEW_SECRET)),
    getAddress: jest.fn(async (majorIndex, subaddressIndex) =>
      addressByPosition.get(`${majorIndex}:${subaddressIndex}`) ?? null)
  }
  const daemon = {
    getPaymentTransactions: jest.fn(async hashes => {
      const records = (Array.isArray(hashes) ? hashes : []).map(hash => rawByHash[hash]).filter(Boolean)
      // Task 5 fix I1 (additive): resolve the block hash per DISTINCT height
      // like the real daemonClient, so raw records carry `blockHash`.
      const resolved = new Map()
      for (const record of records) {
        if (!resolved.has(record.blockHeight)) {
          resolved.set(record.blockHeight, await daemon.getBlockHashByHeight(record.blockHeight))
        }
        record.blockHash = resolved.get(record.blockHeight)
      }
      return records
    }),
    getHeight: jest.fn(async () => BOUNDARY.height + 1),
    getBlockHashByHeight: jest.fn(async () => BOUNDARY.blockHash)
  }
  const derivation = {
    complete: true,
    primaryAddress: state.scope.walletAddress,
    derived: [...addressByPosition.entries()].map(([position, address]) => {
      const [majorIndex, minorIndex] = position.split(':').map(Number)
      return { majorIndex, minorIndex, address }
    }),
    domain: [...addressByPosition.entries()].map(([position, address]) => {
      const [accountIndex, subaddressIndex] = position.split(':').map(Number)
      return { accountIndex, subaddressIndex, address }
    }),
    mismatches: []
  }
  const boundary = { height: BOUNDARY.height, blockHash: BOUNDARY.blockHash }
  const session = {
    scope: { network: state.scope.network, walletAddress: state.scope.walletAddress },
    rawByHash,
    ownedOutputs: [changeRow],
    ownershipFor: hash => (hash === state.txHash
      ? { owned: [changeRow], inputSources: [sourceRow] }
      : { owned: [], inputSources: [] }),
    deriveOwnedIndexes: () => [{ accountIndex: 0, subaddressIndex: 0 }],
    // Final-review I4/I6: the session carries its authoritative collection
    // boundary and the independent position→address mapper from the prepared
    // derivation domain.
    boundary: { height: boundary.height, blockHash: boundary.blockHash },
    addressForPosition: (majorIndex, subaddressIndex) =>
      addressByPosition.get(`${majorIndex}:${subaddressIndex}`) ?? null,
    derivedPositions: [...addressByPosition.entries()].map(([position, address]) => {
      const [majorIndex, minorIndex] = position.split(':').map(Number)
      return { majorIndex, minorIndex, address }
    }),
    // Task 5 (additive): verification sessions carry the captured sender
    // wallet's receipt checker so the verifier can run the exact checkTxKey
    // gate. Same jest.fn instance as `wallet.checkTxKey`.
    checkTxKey
  }
  const hiddenExtra = hiddenExtraAmount > 0n
    ? {
        amountPiconeros: hiddenExtraAmount,
        stealthPublicKey: hiddenExtraVout,
        globalIndex: outputIndices[outputIndices.length - 1],
        address: ADDRESSES[state.network].hiddenExtra
      }
    : null

  return {
    txHash: state.txHash,
    observedAt: DEFAULT_OBSERVED_AT,
    checkTxKeyResult: externalTotal,
    totals: {
      D: D_PICONEROS.toString(),
      O: ownedAmount.toString(),
      F: fee.toString(),
      E: externalTotal.toString(),
      residual: hiddenExtraAmount.toString()
    },
    wallet,
    viewWallet,
    daemon,
    collectOptions: {
      wallet,
      daemon,
      scope: state.scope,
      derivation,
      boundary,
      viewWallet
    },
    verifyOptions: {
      journalRole: state.journalRole,
      journalId: '1',
      session
    },
    session,
    chain: {
      network: state.network,
      walletAddress: state.scope.walletAddress,
      boundary,
      audited,
      source,
      spend,
      sourceScan: sourceRow,
      ownedScan: [changeRow],
      hiddenExtra,
      externalReceipts,
      keyImages: { source: KEY_IMAGES.source, change: KEY_IMAGES.change },
      mainPublicKey: auditedKeys.mainPublicKey,
      additionalPublicKeys: [...auditedKeys.additionalPublicKeys],
      D: D_PICONEROS,
      O: ownedAmount,
      F: fee,
      E: externalTotal,
      residual: hiddenExtraAmount
    }
  }
}

// ---------------------------------------------------------------------------
// Rewards accounting audit fixture (rewards reconciliation plan, Task 1).
//
// One complete synthetic DB-shaped ledger input for the shared audit snapshot
// and the `accounting:v2:` fingerprint: every group and every exact column of
// the plan's projection inventory, all values throwaway and deterministic.
// No real wallet, address, hash, key or transaction exists here — hashes and
// digests are repeated synthetic hex digits, addresses reuse the synthetic
// curve points already built above.
//
// Shape (consumed by accountingAuditProjection / readRewardsAuditSnapshot):
//   { scope, ledger: { accounts, subaddresses, receipts, downvotes, payouts,
//     distributions, transactions, escrowTransactions, bountyPayments,
//     observedBounties, observedBountyReceipts, items, earns, proofInventory },
//     config, reserve }
// Rows are Prisma-shaped: BigInt ids/amounts, Date timestamps, `confirmations`
// counters present where the DB has them (the projection must EXCLUDE them).
// ---------------------------------------------------------------------------

const AUDIT_NETWORK = 'STAGENET'
const AUDIT_WALLET_ADDRESS = ADDRESSES.STAGENET.wallet
const AUDIT_ESCROW_ADDRESS = ADDRESSES.STAGENET.accountPrimary[2]
const AUDIT_POSTING_ADDRESS = ADDRESSES.STAGENET.recipientB
const AUDIT_TERRITORY_ADDRESS = encodeAddress({ network: 'STAGENET', type: 'SUBADDRESS', ...ACCOUNT_PRIMARY_KEYS[5] })
const AUDIT_CURATOR_ADDRESS = ADDRESSES.STAGENET.accountPrimary[3]
const AUDIT_WINNER_ADDRESS = ADDRESSES.STAGENET.accountPrimary[4]

const auditHash = seed => seed.toString(16).padStart(2, '0').repeat(32)
const auditUuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const auditAt = hours => new Date(Date.UTC(2026, 8, 1, hours))

/**
 * Complete synthetic audit-ledger input covering every required column of the
 * `accounting:v2:` projection inventory. Returns a fresh deep object per call
 * (BigInts and Dates are structured-clone safe, so tests may mutate a clone).
 *
 * @returns {object} `{ scope, ledger, config, reserve }`
 */
export function auditLedgerFixture () {
  return {
    scope: { network: AUDIT_NETWORK, walletAddress: AUDIT_WALLET_ADDRESS },
    ledger: {
      // Scope/derivation: MoneroAccount id/label/network/address and
      // SubaddressIndex id/accountId/majorIndex/minorIndex/address/state.
      accounts: [
        { id: 1, label: 'platform_rewards', network: AUDIT_NETWORK, address: AUDIT_WALLET_ADDRESS },
        { id: 2, label: 'bounty_escrow', network: AUDIT_NETWORK, address: AUDIT_ESCROW_ADDRESS }
      ],
      subaddresses: [
        { id: 11, accountId: 1, majorIndex: 0, minorIndex: 0, address: AUDIT_WALLET_ADDRESS, state: 'AVAILABLE' },
        { id: 12, accountId: 1, majorIndex: 1, minorIndex: 0, address: AUDIT_POSTING_ADDRESS, state: 'ASSIGNED' },
        { id: 13, accountId: 1, majorIndex: 2, minorIndex: 0, address: AUDIT_TERRITORY_ADDRESS, state: 'AVAILABLE' },
        { id: 21, accountId: 2, majorIndex: 0, minorIndex: 0, address: AUDIT_ESCROW_ADDRESS, state: 'AVAILABLE' }
      ],
      // FeeObservation: every receipt state, a BOOST row (boost allocation),
      // a legacy walletReceipt=false BOUNTY_FEE row and an unreadable hash
      // carrying a positive material amount (retained, never dropped).
      receipts: [
        {
          id: 101n,
          txHash: auditHash(0xa1),
          feeType: 'BOOST',
          postId: 501,
          subName: null,
          payInId: null,
          recipientMajor: 1,
          recipientMinor: 0,
          walletReceipt: true,
          state: 'CONFIRMED',
          piconeros: 700n,
          rewardsPiconeros: null,
          donationRewardsPct: null,
          height: 2999001,
          confirmedAt: auditAt(1),
          confirmations: 40
        },
        {
          id: 102n,
          txHash: auditHash(0xa2),
          feeType: 'POSTING',
          postId: 502,
          subName: null,
          payInId: 6001,
          recipientMajor: 1,
          recipientMinor: 0,
          walletReceipt: true,
          state: 'CONFIRMED',
          piconeros: 500n,
          rewardsPiconeros: 350n,
          donationRewardsPct: null,
          height: 2999002,
          confirmedAt: auditAt(2),
          confirmations: 39
        },
        {
          id: 103n,
          txHash: auditHash(0xa3),
          feeType: 'DONATE',
          postId: 501,
          subName: null,
          payInId: 6002,
          recipientMajor: 0,
          recipientMinor: 0,
          walletReceipt: true,
          state: 'PENDING',
          piconeros: 900n,
          rewardsPiconeros: null,
          donationRewardsPct: 60,
          height: null,
          confirmedAt: null
        },
        {
          id: 104n,
          txHash: 'not-a-chain-hash',
          feeType: 'TIP_UNWALLETED',
          postId: null,
          subName: null,
          payInId: null,
          recipientMajor: 0,
          recipientMinor: 0,
          walletReceipt: true,
          state: 'DETECTED',
          piconeros: 300n,
          rewardsPiconeros: null,
          donationRewardsPct: null,
          height: null,
          confirmedAt: null
        },
        {
          id: 105n,
          txHash: auditHash(0xa5),
          feeType: 'BOUNTY_FEE',
          postId: null,
          subName: 'terry',
          payInId: null,
          recipientMajor: 2,
          recipientMinor: 0,
          walletReceipt: false,
          state: 'CONFIRMED',
          piconeros: 200n,
          rewardsPiconeros: null,
          donationRewardsPct: null,
          height: 2999005,
          confirmedAt: auditAt(5),
          confirmations: 36
        }
      ],
      // ObservedDownvote: NO recipient account/index columns exist — the
      // receiving scope is the platform_rewards primary address.
      downvotes: [
        {
          id: 201n,
          txHash: auditHash(0xb1),
          paymentId: '1b2c3d4e5f607101',
          postId: 501,
          downvoterId: 7,
          state: 'CONFIRMED',
          piconeros: 1000n,
          height: 2999010,
          confirmedAt: auditAt(10),
          confirmations: 30
        },
        {
          id: 202n,
          txHash: auditHash(0xb2),
          paymentId: '1b2c3d4e5f607102',
          postId: 502,
          downvoterId: null,
          state: 'DETECTED',
          piconeros: 1000n,
          height: null,
          confirmedAt: null
        }
      ],
      payouts: [
        {
          id: 301,
          distributionId: 401,
          curatorId: 7,
          recipientAddress: AUDIT_CURATOR_ADDRESS,
          piconeros: 400n,
          state: 'SENT',
          txHash: auditHash(0xc1)
        }
      ],
      distributions: [
        {
          id: 401,
          status: 'COMPLETE',
          periodStart: auditAt(0),
          periodEnd: auditAt(24 * 7),
          poolPiconeros: 2000n,
          distributedPiconeros: 400n,
          rolledOverPiconeros: 1600n,
          payoutCount: 1,
          opsInflowPiconeros: 800n,
          opsRolledOverPiconeros: 100n,
          opsAvailablePiconeros: 900n,
          opsSweptPiconeros: 500n,
          opsSweepState: 'SWEPT',
          opsSweepTxHash: auditHash(0xc2),
          opsNetworkFeesAccountedPiconeros: 7n
        }
      ],
      // RewardsWalletTransaction: one proof-era RELAYED PAYOUT and one legacy
      // PREPARED OPS_SWEEP (no capture tuple, no proof).
      transactions: [
        {
          id: 501n,
          network: AUDIT_NETWORK,
          walletAddress: AUDIT_WALLET_ADDRESS,
          txHash: auditHash(0xd1),
          kind: 'PAYOUT',
          accountIndex: 0,
          distributionId: 401,
          principalPiconeros: 400n,
          networkFeePiconeros: 7n,
          metadata: { payouts: [{ payoutId: '301', recipientAddress: AUDIT_CURATOR_ADDRESS, piconeros: '400' }] },
          state: 'RELAYED',
          preparedAt: auditAt(20),
          relayAttemptedAt: auditAt(21),
          relayedAt: auditAt(22),
          relayProvenance: 'RELAY_TX',
          dispatchId: auditUuid(1),
          captureContractVersion: 1,
          claimDigest: auditHash(0xd2),
          paymentClaims: null,
          proofId: auditUuid(11)
        },
        {
          id: 502n,
          network: AUDIT_NETWORK,
          walletAddress: AUDIT_WALLET_ADDRESS,
          txHash: auditHash(0xd3),
          kind: 'OPS_SWEEP',
          accountIndex: 0,
          distributionId: 401,
          principalPiconeros: 500n,
          networkFeePiconeros: 6n,
          metadata: { destination: AUDIT_WALLET_ADDRESS },
          state: 'PREPARED',
          preparedAt: auditAt(30),
          relayAttemptedAt: null,
          relayedAt: null,
          relayProvenance: null,
          dispatchId: auditUuid(2),
          captureContractVersion: null,
          claimDigest: null,
          paymentClaims: null,
          proofId: null
        }
      ],
      // EscrowWalletTransaction: always a complete proof-era capture.
      escrowTransactions: [
        {
          id: 601n,
          network: AUDIT_NETWORK,
          walletAddress: AUDIT_ESCROW_ADDRESS,
          txHash: auditHash(0xe1),
          dispatchId: auditUuid(3),
          proofId: auditUuid(12),
          captureContractVersion: 1,
          claimDigest: auditHash(0xe2),
          paymentClaims: null,
          kind: 'AWARD',
          leg: 'DISPOSITION',
          bountyPaymentId: 701,
          itemId: 503,
          accountIndex: 0,
          principalPiconeros: 5000n,
          networkFeePiconeros: 8n,
          metadata: { destination: AUDIT_WINNER_ADDRESS },
          state: 'RELAYED',
          preparedAt: auditAt(40),
          relayAttemptedAt: auditAt(41),
          relayedAt: auditAt(42),
          relayProvenance: 'RELAY_TX'
        }
      ],
      // BountyPayment: full settlement-facts shape.
      bountyPayments: [
        {
          id: 701,
          itemId: 503,
          winnerUserId: 9,
          kind: 'AWARD',
          piconeros: 5000n,
          feePiconeros: 100n,
          recipientAddress: AUDIT_WINNER_ADDRESS,
          feeRecipientAddress: AUDIT_WALLET_ADDRESS,
          state: 'CONFIRMED',
          txHash: auditHash(0xe1),
          feeTxHash: auditHash(0xe3),
          feePendingAt: auditAt(43),
          networkFeePiconeros: 8n,
          recipientReceivedPiconeros: 5000n,
          feeReceivedPiconeros: 100n,
          feeSettlementNetworkFeePiconeros: 2n,
          sentAt: auditAt(44),
          confirmedAt: auditAt(45),
          height: 2999045
        }
      ],
      // ObservedBounty funding facts: one settled funding (whose item also
      // has a BountyPayment) and one IN-FLIGHT funding on item 504 — an item
      // with NO BountyPayment row, so its terms are linked only through
      // ObservedBounty.postId.
      observedBounties: [
        {
          id: 801n,
          postId: 503,
          payerId: 12,
          recipientAccountId: 2,
          paymentId: '2b2c3d4e5f607201',
          txHash: auditHash(0xf1),
          piconeros: 5200n,
          state: 'CONFIRMED',
          height: 2999050,
          confirmedAt: auditAt(50)
        },
        {
          id: 802n,
          postId: 504,
          payerId: 13,
          recipientAccountId: 2,
          paymentId: '2b2c3d4e5f607202',
          txHash: auditHash(0xf2),
          piconeros: 3100n,
          state: 'DETECTED',
          height: null,
          confirmedAt: null
        }
      ],
      // ObservedBountyReceipt: no state column exists on this model.
      observedBountyReceipts: [
        { id: 901n, bountyId: 801n, txHash: auditHash(0xf1), piconeros: 5200n, height: 2999050, detectedAt: auditAt(49) }
      ],
      // Linked Item terms: the bounty payment's item AND the in-flight
      // funding item 504 (no BountyPayment exists for it).
      items: [
        { id: 503, bountyPiconeros: 5200n, bountyFeePiconeros: 100n },
        { id: 504, bountyPiconeros: 3000n, bountyFeePiconeros: null }
      ],
      // Protected reward contracts.
      earns: [
        { id: 1001, userId: 7, distributionId: 401, piconeros: 250n },
        { id: 1002, userId: 9, distributionId: 401, piconeros: 150n }
      ],
      // Safe proof inventory: owner/reference plus the #1 store's inventory
      // record (safe metadata + integrity digests, never envelope bytes).
      proofInventory: [
        {
          owner: { journalRole: 'REWARDS', journalId: 501n },
          reference: {
            txHash: auditHash(0xd1),
            kind: 'PAYOUT',
            dispatchId: auditUuid(1),
            leg: null,
            bountyPaymentId: null,
            itemId: null
          },
          proof: {
            proofId: auditUuid(11),
            revision: 1,
            masterKeyVersion: 1,
            bindingVersion: 1,
            envelopeVersion: 1,
            payloadVersion: 1,
            claimDigest: auditHash(0xd2),
            bindingDigest: auditHash(0xd4),
            envelopeIntegrityDigest: auditHash(0xd5)
          }
        },
        {
          owner: { journalRole: 'ESCROW', journalId: 601n },
          reference: {
            txHash: auditHash(0xe1),
            kind: 'AWARD',
            dispatchId: auditUuid(3),
            leg: 'DISPOSITION',
            bountyPaymentId: 701,
            itemId: 503
          },
          proof: {
            proofId: auditUuid(12),
            revision: 1,
            masterKeyVersion: 1,
            bindingVersion: 1,
            envelopeVersion: 1,
            payloadVersion: 1,
            claimDigest: auditHash(0xe2),
            bindingDigest: auditHash(0xe4),
            envelopeIntegrityDigest: auditHash(0xe5)
          }
        }
      ]
    },
    config: {
      downvoteRewardsPct: 100,
      postingFeeRewardsPct: 70,
      territoryFeeRewardsPct: 30,
      boostRewardsPct: 30,
      walletlessTipRewardsPct: 70
    },
    reserve: { feeHeadroomPiconeros: 1000000000n, dustFloorPiconeros: 1000000000n }
  }
}
