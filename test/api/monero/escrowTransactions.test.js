/* eslint-env jest */
import { readFileSync } from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { ed25519 } from '@noble/curves/ed25519'
import { base58xmr } from '@scure/base'
import { keccak256 } from 'js-sha3'
import { alert } from '@/lib/alert'
import { logError, logInfo, logWarn } from '@/lib/logger'
import { createPaymentProofKeyProvider } from '@/api/monero/paymentProofKeys'
import { loadPaymentProof } from '@/api/monero/paymentProofStore'
import { readBountySettlement } from '@/api/monero/bountySettlement'
import { sendBountyPayments } from '@/api/monero/bounties'
import { decodeReceivingIdentity } from '@/api/monero/paymentClaims'
import { oneTimeOutputKey, senderPublicPart } from '@/api/monero/paymentKeyStructure'
import {
  prepareEscrowTransaction,
  reconcileEscrowTransactions,
  relayEscrowTransaction
} from '@/api/monero/escrowTransactions'

// lib/alert and lib/logger are mocked (same pattern as
// test/api/monero/rewardsTransactions.test.js): operator pages are assertable
// without a network side effect, and every log call is captured so nothing
// sensitive can hide in pino output.
jest.mock(`${process.cwd()}/lib/alert`, () => ({
  alert: jest.fn()
}))
jest.mock(`${process.cwd()}/lib/logger`, () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn()
}))

// Isolated real-DB tests for the escrow capture barrier and reconciliation
// (Finding #1, Task 7). Every bounty escrow dispatch — the combined
// disposition tx (AWARD/RECLAIM prize + fee, or the single net output for
// ROLLOVER / fee-waived refunds) and the legacy separate-fee retry — follows
// the same boundary: build(relay:false) -> extract the ACTUAL settlement from
// the built object BEFORE the pair commits -> durable journal+proof PAIR
// (ESCROW owner role) -> fresh pair authentication -> locked attempt CAS ->
// relayTx(the SAME object) once -> persist through the existing guarded paths.
// The five-branch crash/race matrix is binding: a relay timeout or a
// post-relay persistence failure with the payout still QUEUED (or
// feePendingAt still set) can never cause a second broadcast, because the
// durable dispatch (attempted, unattempted, or RELAYED) withholds that exact
// bountyPaymentId+leg on every later drive.
//
// Real Task 2 crypto, real store rows, real BountyPayment/Item/User rows; the
// wallet is a capture-grade fake. Runs ONLY via the guarded isolated runner.
// Local helpers only (R6): no shared test modules.

const ISOLATED_DB = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname === '/stasher_rewards_repair_test' } catch { return false }
})()

// --- deterministic synthetic address/point helpers (throwaway, Task 1 style)
// Scalar space starts at 900 to stay clear of the shared fixture scalars and
// the rewards barrier suite's 100s/300s/400s/70s.

const point = scalar => Buffer.from(ed25519.ExtendedPoint.BASE.multiply(BigInt(scalar)).toRawBytes()).toString('hex')

const STAGENET_PRIMARY_PREFIX = 24
function encodeStagenetPrimaryAddress ({ spendKey, viewKey }) {
  const body = new Uint8Array(65)
  body[0] = STAGENET_PRIMARY_PREFIX
  body.set(Buffer.from(spendKey, 'hex'), 1)
  body.set(Buffer.from(viewKey, 'hex'), 33)
  const checksum = Buffer.from(keccak256(body), 'hex').subarray(0, 4)
  return base58xmr.encode(new Uint8Array([...body, ...checksum]))
}

const makeAddress = n => encodeStagenetPrimaryAddress({ spendKey: point(2n * BigInt(n)), viewKey: point(2n * BigInt(n) + 1n) })
// Little-endian secret-scalar hex (the SDK key-bundle string form).
const leHex = value => {
  let hex = BigInt(value).toString(16)
  if (hex.length % 2) hex = `0${hex}`
  return Buffer.from(hex.padStart(64, '0'), 'hex').reverse().toString('hex')
}
// Real one-time-key arithmetic for one built escrow tx: external vouts via
// the sender path against the recipients' PUBLIC keys, the change vout via
// the receiver a*R path against the escrow wallet's own spend key
// (final-review C1/I1/I2).
function escrowDerivedKeys ({ destinations, changeAddress, scalarBase, hotViewScalar, hotSpendPoint }) {
  const decoded = destinations.map(d => decodeReceivingIdentity(d.address, 'STAGENET'))
  const slots = destinations.length + (changeAddress ? 1 : 0)
  const slotSecrets = Array.from({ length: slots }, (_, i) => scalarBase + BigInt(i))
  const slotPublics = slotSecrets.map(secret => senderPublicPart(secret, null))
  const outputKeys = decoded.map((keys, i) => oneTimeOutputKey({
    publicKey: keys.viewKey,
    secret: leHex(slotSecrets[i]),
    publicSpend: keys.spendKey,
    outputIndex: i
  }))
  if (changeAddress) {
    outputKeys.push(oneTimeOutputKey({
      publicKey: slotPublics[slots - 1],
      secret: leHex(hotViewScalar),
      publicSpend: hotSpendPoint,
      outputIndex: slots - 1
    }))
  }
  return {
    mainSecretHex: leHex(scalarBase),
    additionalSecretHexes: slotSecrets.map(leHex),
    mainPublicKey: senderPublicPart(scalarBase, null),
    additionalPublicKeys: slotPublics,
    outputKeys,
    additionalKeyCount: slots
  }
}

;(ISOLATED_DB ? describe : describe.skip)('escrow dispatch capture barrier and reconciliation (isolated DB only)', () => {
  // The escrow scope: the fake signer wallet's own primary address (a real
  // decodable stagenet primary). Recipients/cold addresses are distinct.
  const WADDR = makeAddress(900)
  const SCOPE = { network: 'STAGENET', walletAddress: WADDR }
  const A = makeAddress(901) // bounty recipient
  const COLD = makeAddress(902) // frozen fee destination (REWARDS_COLD_STORAGE_ADDRESS)

  // Synthetic throwaway TX-proof registries (never real secrets). The "lost"
  // registry holds a DIFFERENT current version, so envelopes sealed with one
  // provider cannot be opened with the other — the production fail-closed
  // path, exercised through real crypto.
  const keyProvider = createPaymentProofKeyProvider({
    TXPROOF_MASTER_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 11).toString('base64') }),
    TXPROOF_MASTER_KEY_CURRENT_VERSION: '1'
  })
  const lostKeyProvider = createPaymentProofKeyProvider({
    TXPROOF_MASTER_KEYS: JSON.stringify({ 2: Buffer.alloc(32, 13).toString('base64') }),
    TXPROOF_MASTER_KEY_CURRENT_VERSION: '2'
  })

  const NET_FEE = 40_000n
  const PRIZE = 10_000_000_000n
  const FEE = 2_000_000_000n
  const ROLLOVER_PRIZE = 12_000_000_000n
  const LEGACY_FEE = 10_000_000_000n
  const PRIZE_HASH = 'ab'.repeat(32)
  const LEGACY_PENDING_AT = new Date('2026-10-06T00:00:00Z')

  let db
  let hashSeq
  let trackedUsers
  let trackedItems
  let trackedPayments
  let envSnapshot

  const nextHash = () => {
    hashSeq += 1
    return ('e7' + String(hashSeq).padStart(4, '0') + 'a1').repeat(8) // 64 lowercase hex
  }

  const purgeScope = () => db.$transaction([
    // Pairs leave TOGETHER (proofs before owners — the store's delete guard).
    db.paymentTransactionProof.deleteMany({ where: { escrowJournal: { walletAddress: WADDR } } }),
    db.escrowWalletTransaction.deleteMany({ where: { walletAddress: WADDR } })
  ])

  beforeAll(async () => {
    db = new PrismaClient()
    envSnapshot = {}
    for (const key of ['BOUNTY_ESCROW_ADDRESS', 'BOUNTY_ESCROW_SPEND_KEY', 'BOUNTY_ESCROW_VIEW_KEY', 'REWARDS_COLD_STORAGE_ADDRESS']) {
      envSnapshot[key] = process.env[key]
      delete process.env[key]
    }
    process.env.REWARDS_COLD_STORAGE_ADDRESS = COLD
    // Purge any residue from an interrupted earlier run of this suite (the
    // scope is owned by this suite).
    await purgeScope()
  })

  beforeEach(() => {
    hashSeq = 0
    trackedUsers = []
    trackedItems = []
    trackedPayments = []
    jest.clearAllMocks()
  })

  afterEach(async () => {
    // Fixture-owned cleanup: pairs first, then journals, payouts, items, users.
    await purgeScope()
    await db.bountyPayment.deleteMany({ where: { id: { in: trackedPayments } } })
    for (const id of trackedItems) await db.item.delete({ where: { id } })
    for (const id of trackedUsers) await db.user.delete({ where: { id } })
  })

  afterAll(async () => {
    if (db) await db.$disconnect()
    for (const key of Object.keys(envSnapshot)) {
      if (envSnapshot[key] === undefined) delete process.env[key]
      else process.env[key] = envSnapshot[key]
    }
  })

  // --- local helpers (R6) ------------------------------------------------------

  // Capture-grade fake escrow signer: builds (relay:false) carry the real fee,
  // the actual post-subtraction destinations, the change fields and the exact
  // key bundle through SDK-shaped getters; relayTx is the single broadcast.
  function makeWallet ({ unlocked = 1_000_000_000_000_000n, netFee = NET_FEE, throwsOn = {}, missingSettlement = false } = {}) {
    let balance = unlocked
    let builds = 0
    const built = []
    return {
      built,
      relayTx: jest.fn(async tx => String(await tx.getHash()).toLowerCase()),
      getPrimaryAddress: jest.fn(async () => WADDR),
      getNetworkType: jest.fn(async () => 2),
      sync: jest.fn(async () => {}),
      getUnlockedBalance: jest.fn(async () => balance),
      getTx: jest.fn(async () => ({ getHeight: async () => 200 })),
      createTx: jest.fn(async req => {
        const requested = req.destinations
          ? req.destinations.map(d => ({ address: d.address, amount: BigInt(d.amount) }))
          : [{ address: req.address, amount: BigInt(req.amount) }]
        for (const destination of requested) {
          if (throwsOn[destination.address]) throw throwsOn[destination.address]
        }
        const destSum = requested.reduce((acc, d) => acc + d.amount, 0n)
        // wallet2's contract: the network fee rides inside subtractFeeFrom
        // destinations; without subtractFeeFrom it is charged on top.
        if (balance < destSum + (req.subtractFeeFrom ? 0n : netFee)) throw new Error('not enough unlocked money')
        balance -= destSum + (req.subtractFeeFrom ? 0n : netFee)
        builds += 1
        const hash = nextHash()
        const keySeed = 400n + BigInt(builds) * 7n
        const actual = requested.map((d, i) => ({
          address: d.address,
          amount: d.amount - (req.subtractFeeFrom && req.subtractFeeFrom.includes(i) ? netFee : 0n)
        }))
        const keys = escrowDerivedKeys({
          destinations: actual,
          changeAddress: WADDR,
          scalarBase: keySeed,
          hotViewScalar: 2n * 900n + 1n,
          hotSpendPoint: point(2n * 900n)
        })
        const tx = {
          getHash: () => hash,
          getFee: () => netFee,
          getOutgoingTransfer: () => (missingSettlement
            ? undefined
            : { getDestinations: () => actual.map(d => ({ getAddress: () => d.address, getAmount: () => d.amount })) }),
          getChangeAddress: () => WADDR,
          getChangeAmount: () => destSum - netFee,
          // The SDK captures the SECRET-bundle STRING (final-review C1);
          // populated public facts ride the optional getters.
          getKey: () => keys.mainSecretHex + keys.additionalSecretHexes.join(''),
          getMainPublicKey: () => keys.mainPublicKey,
          getAdditionalPublicKeys: () => [...keys.additionalPublicKeys],
          getOutputKeys: () => [...keys.outputKeys]
        }
        built.push(tx)
        return tx
      })
    }
  }

  // A real BountyPayment row (FK-safe item + user), tracked for cleanup.
  const seedPayout = async (overrides = {}) => {
    const [user] = await db.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
    trackedUsers.push(user.id)
    const item = await db.item.create({
      data: { userId: user.id, title: `escrow barrier fixture ${trackedItems.length + 1}`, status: 'ACTIVE' }
    })
    trackedItems.push(item.id)
    const payout = await db.bountyPayment.create({
      data: {
        itemId: item.id,
        winnerUserId: user.id,
        piconeros: PRIZE,
        feePiconeros: FEE,
        recipientAddress: A,
        kind: 'AWARD',
        state: 'QUEUED',
        ...overrides
      }
    })
    trackedPayments.push(payout.id)
    return payout
  }

  // The pinned five-branch fixture (coordinator ruling R6: local helper, real
  // frozen payment + item + capture-grade fake wallet + real store rows).
  async function seedEscrowDispatchFixture (db, branch) {
    const wallet = makeWallet()
    const options = { models: db, wallet, keyProvider }
    if (branch === 'LEGACY_SEPARATE_FEE') {
      const payout = await seedPayout({
        state: 'SENT',
        txHash: PRIZE_HASH,
        feePiconeros: LEGACY_FEE,
        feePendingAt: LEGACY_PENDING_AT,
        feeRecipientAddress: COLD
      })
      return {
        payout,
        wallet,
        options,
        protectedTerms: { state: 'SENT', txHash: PRIZE_HASH, feeTxHash: null, feePendingAt: LEGACY_PENDING_AT }
      }
    }
    const rollover = branch === 'ROLLOVER'
    const feeWaived = branch === 'FEE_WAIVED'
    const payout = await seedPayout({
      kind: branch === 'RECLAIM' ? 'RECLAIM' : 'AWARD',
      piconeros: rollover ? ROLLOVER_PRIZE : PRIZE,
      feePiconeros: (rollover || feeWaived) ? 0n : FEE
    })
    const protectedTerms = {
      state: 'QUEUED',
      recipientAddress: A,
      piconeros: rollover ? ROLLOVER_PRIZE : PRIZE,
      txHash: null
    }
    if (!rollover && !feeWaived) protectedTerms.feeRecipientAddress = COLD
    return { payout, wallet, options, protectedTerms }
  }

  const loadJournal = async payoutId =>
    db.escrowWalletTransaction.findFirst({ where: { bountyPaymentId: payoutId } })

  // Wrap the real Prisma client so selected bountyPayment.update calls fail
  // (R6 proxy pattern; $transaction hands its callback a wrapped client).
  const withFaultyPayoutUpdate = (match, impl) => {
    const wrap = target => new Proxy(target, {
      get (inner, prop) {
        if (prop === 'bountyPayment') {
          const delegate = Reflect.get(inner, prop, inner)
          return new Proxy(delegate, {
            get (innerDelegate, modelProp) {
              if (modelProp === 'update') {
                const fn = Reflect.get(innerDelegate, modelProp, innerDelegate)
                return (...args) => (match(args) ? impl(...args) : fn.apply(innerDelegate, args))
              }
              const value = Reflect.get(innerDelegate, modelProp, innerDelegate)
              return typeof value === 'function' ? value.bind(innerDelegate) : value
            }
          })
        }
        if (prop === '$transaction') {
          const transactional = Reflect.get(inner, prop, inner)
          return (fn, options) => transactional.call(inner, client => fn(wrap(client)), options)
        }
        const value = Reflect.get(inner, prop, inner)
        return typeof value === 'function' ? value.bind(inner) : value
      }
    })
    return wrap(db)
  }

  // --- dedicated escrow audit chain (fresh-verification resolution) -----------
  // A fake audit wallet + fake daemon whose raw records mirror a built tx's
  // key bundle byte for byte, with one owned coinbase source, the owned change
  // output at (0,0), and exact confirmed receipts — the same shape the rewards
  // barrier suite drives through the REAL collector/verifier seam.

  const LOCAL_TIP = { height: 2_999_999, blockHash: 'cd'.repeat(32) }
  const LOCAL_SOURCE_HASH = 'e1'.repeat(32)

  function localEscrowAuditChain ({ tx }) {
    const fee = tx.getFee()
    const actual = tx.getOutgoingTransfer().getDestinations().map(d => ({
      address: d.getAddress(),
      amount: d.getAmount()
    }))
    const changeAmount = tx.getChangeAmount()
    const keys = {
      mainPublicKey: tx.getMainPublicKey(),
      additionalPublicKeys: tx.getAdditionalPublicKeys(),
      outputKeys: tx.getOutputKeys()
    }
    const auditedHeight = LOCAL_TIP.height - 19 // 20 confirmations
    const sourceHeight = LOCAL_TIP.height - 999 // 1000 confirmations
    const changeGlobalIndex = 900 + keys.outputKeys.length - 1 // the change vout is LAST
    const D = actual.reduce((acc, d) => acc + d.amount, 0n) + changeAmount + fee
    const audited = {
      txHash: tx.getHash(),
      feePiconeros: fee,
      inputKeyImages: [point(70n)],
      voutKeys: keys.outputKeys,
      outputIndices: keys.outputKeys.map((_, index) => 900 + index),
      blockHeight: auditedHeight,
      blockHash: LOCAL_TIP.blockHash,
      confirmations: 20,
      inTxPool: false,
      isCoinbase: false,
      mainPublicKey: keys.mainPublicKey,
      additionalPublicKeys: [...keys.additionalPublicKeys]
    }
    // The coinbase source output is wallet-owned: derive it on the receiver
    // a*R path under its own main tx key (final-review I2 enumeration).
    const sourceMainKey = senderPublicPart(70n, null)
    const sourceVout = oneTimeOutputKey({
      publicKey: sourceMainKey,
      secret: leHex(2n * 900n + 1n),
      publicSpend: point(2n * 900n),
      outputIndex: 0
    })
    const source = {
      txHash: LOCAL_SOURCE_HASH,
      feePiconeros: 0n,
      inputKeyImages: [],
      voutKeys: [sourceVout],
      outputIndices: [700],
      blockHeight: sourceHeight,
      blockHash: LOCAL_TIP.blockHash,
      confirmations: 1000,
      inTxPool: false,
      isCoinbase: true,
      mainPublicKey: sourceMainKey,
      additionalPublicKeys: []
    }
    const sourceRow = {
      txHash: LOCAL_SOURCE_HASH,
      accountIndex: 0,
      subaddressIndex: 0,
      outputIndex: 0,
      blockHeight: sourceHeight,
      globalIndex: 700,
      amountPiconeros: D,
      stealthPublicKey: sourceVout,
      keyImage: point(70n),
      isSpent: true
    }
    const changeOutput = {
      getTx: () => ({ getHash: () => tx.getHash(), getHeight: () => auditedHeight }),
      getAccountIndex: () => 0,
      getSubaddressIndex: () => 0,
      getIndex: () => changeGlobalIndex,
      getAmount: () => changeAmount,
      getStealthPublicKey: () => keys.outputKeys[keys.outputKeys.length - 1],
      getKeyImage: () => null,
      getIsSpent: () => false
    }
    const receipts = new Map(actual.map(d => [d.address, { amount: d.amount, confirmations: 20 }]))
    const wallet = {
      getOutputs: jest.fn(async () => [
        changeOutput,
        {
          getTx: () => ({ getHash: () => sourceRow.txHash, getHeight: () => sourceRow.blockHeight }),
          getAccountIndex: () => sourceRow.accountIndex,
          getSubaddressIndex: () => sourceRow.subaddressIndex,
          getIndex: () => sourceRow.globalIndex,
          getAmount: () => sourceRow.amountPiconeros,
          getStealthPublicKey: () => sourceRow.stealthPublicKey,
          getKeyImage: () => ({ getHex: () => sourceRow.keyImage }),
          getIsSpent: () => true
        }
      ]),
      getAccounts: jest.fn(async () => [0, 1, 2, 3, 4, 5].map(index => ({ getIndex: () => index }))),
      getPrimaryAddress: jest.fn(async () => WADDR),
      getNetworkType: jest.fn(async () => 2),
      // Raw-ownership enumeration seams (final-review I2).
      getPrivateViewKey: jest.fn(async () => leHex(2n * 900n + 1n)),
      getAddress: jest.fn(async (majorIndex, minorIndex) =>
        majorIndex === 0 && minorIndex === 0 ? WADDR : makeAddress(950n + BigInt(majorIndex))),
      checkTxKey: jest.fn(async (_hash, _bundle, address) => {
        const receipt = receipts.get(address)
        if (!receipt) return null
        return {
          getIsGood: () => true,
          getReceivedAmount: () => receipt.amount,
          getInTxPool: () => false,
          getNumConfirmations: () => receipt.confirmations
        }
      }),
      getHeight: jest.fn(async () => LOCAL_TIP.height + 1)
    }
    const rawByHash = { [tx.getHash()]: audited, [LOCAL_SOURCE_HASH]: source }
    const daemon = {
      getPaymentTransactions: jest.fn(async hashes => (Array.isArray(hashes) ? hashes : []).map(h => rawByHash[h]).filter(Boolean)),
      getHeight: jest.fn(async () => LOCAL_TIP.height + 1),
      getBlockHashByHeight: jest.fn(async () => LOCAL_TIP.blockHash)
    }
    return { wallet, daemon }
  }

  // Build the disposition pair for a payout the way the send path does.
  const prepareDisposition = async ({ payout, wallet = makeWallet(), leg = 'DISPOSITION' } = {}) => {
    const fee = payout.kind === 'ROLLOVER' ? 0n : payout.feePiconeros
    const destinations = fee > 0n
      ? [{ address: payout.recipientAddress, amount: payout.piconeros }, { address: payout.feeRecipientAddress, amount: fee }]
      : [{ address: payout.recipientAddress, amount: payout.piconeros }]
    const tx = await wallet.createTx({ accountIndex: 0, destinations, subtractFeeFrom: [destinations.length - 1], relay: false })
    const settlement = await readBountySettlement(tx, { payout, feeRecipientAddress: fee > 0n ? payout.feeRecipientAddress : null })
    const journal = await prepareEscrowTransaction({
      models: db,
      wallet,
      tx,
      payout: { ...payout, feeRecipientAddress: payout.feeRecipientAddress ?? null },
      leg,
      settlement,
      scope: SCOPE,
      keyProvider
    })
    return { journal, tx, wallet }
  }

  const prepareLegacyFee = async ({ payout, wallet = makeWallet() } = {}) => {
    const tx = await wallet.createTx({ accountIndex: 0, address: payout.feeRecipientAddress, amount: payout.feePiconeros, relay: false })
    const journal = await prepareEscrowTransaction({
      models: db,
      wallet,
      tx,
      payout: { ...payout, feeRecipientAddress: payout.feeRecipientAddress },
      leg: 'LEGACY_SEPARATE_FEE',
      settlement: { networkFeePiconeros: tx.getFee(), feeReceivedPiconeros: payout.feePiconeros },
      scope: SCOPE,
      keyProvider
    })
    return { journal, tx, wallet }
  }

  const markAttempted = id => db.escrowWalletTransaction.update({ where: { id }, data: { relayAttemptedAt: new Date() } })

  // --- the pinned five-branch crash/race matrix (verbatim) --------------------

  test.each(['AWARD', 'RECLAIM', 'ROLLOVER', 'FEE_WAIVED', 'LEGACY_SEPARATE_FEE'])(
    '%s never retries a possible broadcast after persistence fails', async branch => {
      const f = await seedEscrowDispatchFixture(db, branch) // local helper: valid frozen payment + item + fake wallet
      f.wallet.relayTx.mockRejectedValueOnce(new Error('secret-sentinel timeout'))
      await sendBountyPayments([f.payout], f.options)
      await sendBountyPayments([f.payout], f.options)
      expect(f.wallet.relayTx).toHaveBeenCalledTimes(1)
      expect(await db.bountyPayment.findUnique({ where: { id: f.payout.id } })).toMatchObject(f.protectedTerms)
    }
  )

  test('the relay-timeout sentinel never reaches any log or alert (fixed labels only)', async () => {
    const f = await seedEscrowDispatchFixture(db, 'AWARD')
    f.wallet.relayTx.mockRejectedValueOnce(new Error('secret-sentinel timeout'))
    await sendBountyPayments([f.payout], f.options)

    const logged = [
      ...logInfo.mock.calls.map(call => JSON.stringify(call)),
      ...logError.mock.calls.map(call => JSON.stringify(call)),
      ...logWarn.mock.calls.map(call => JSON.stringify(call)),
      ...alert.mock.calls.map(call => JSON.stringify(call))
    ]
    expect(logged.length).toBeGreaterThan(0)
    for (const entry of logged) {
      expect(entry.includes('secret-sentinel')).toBe(false)
      expect(entry).not.toMatch(/errorClass":"(?!timeout|connection|rpc|unknown)/)
    }
  })

  test('no relay: true remains on the bounties send path', () => {
    const source = readFileSync(`${process.cwd()}/api/monero/bounties.js`, 'utf8')
    expect(source).not.toMatch(/relay:\s*true/)
  })

  // --- barrier happy path ------------------------------------------------------

  test('AWARD: builds relay:false, relays the SAME object once, and persists SENT with the pre-relay settlement', async () => {
    const payout = await seedPayout()
    const wallet = makeWallet({ unlocked: 12_000_000_000n })

    const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })

    expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, settled: 0 })
    expect(wallet.createTx.mock.calls[0][0]).toMatchObject({
      accountIndex: 0,
      destinations: [
        { address: A, amount: PRIZE },
        { address: COLD, amount: FEE }
      ],
      subtractFeeFrom: [1],
      relay: false
    })
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)
    expect(wallet.relayTx.mock.calls[0][0]).toBe(wallet.built[0]) // the SAME object

    const row = await db.bountyPayment.findUnique({ where: { id: payout.id } })
    expect(row.state).toBe('SENT')
    expect(row.txHash).toBe(wallet.built[0].getHash())
    expect(row.feeRecipientAddress).toBe(COLD)
    expect(row.networkFeePiconeros).toBe(NET_FEE)
    expect(row.recipientReceivedPiconeros).toBe(PRIZE)
    expect(row.feeReceivedPiconeros).toBe(FEE - NET_FEE)
    expect(row.height).toBe(200)

    // The durable pair exists, is RELAYED with direct-relay-observation, and
    // authenticates through the real crypto.
    const journal = await loadJournal(payout.id)
    expect(journal.state).toBe('RELAYED')
    expect(journal.leg).toBe('DISPOSITION')
    expect(journal.kind).toBe('AWARD')
    expect(journal.relayAttemptedAt).not.toBeNull()
    expect(journal.relayProvenance).toBe('direct-relay-observation')
    await expect(loadPaymentProof({ models: db, journalRole: 'ESCROW', journalId: journal.id, keyProvider }))
      .resolves.toMatchObject({ journal: { id: journal.id } })
  })

  test('a successful drive leaves no second drive: the RELAYED dispatch withholds its leg', async () => {
    const payout = await seedPayout()
    const wallet = makeWallet()
    await sendBountyPayments([payout], { models: db, wallet, keyProvider })
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)
    // The payout is SENT, so it is not a fresh candidate anymore; a stale
    // caller-offered copy is still withheld by the durable RELAYED dispatch.
    const stale = await db.bountyPayment.findUnique({ where: { id: payout.id } })
    const second = makeWallet()
    await sendBountyPayments([{ ...stale, state: 'QUEUED' }], { models: db, wallet: second, keyProvider })
    expect(second.relayTx).not.toHaveBeenCalled()
    expect(second.createTx).not.toHaveBeenCalled()
    expect((await db.bountyPayment.findUnique({ where: { id: payout.id } })).txHash).toBe(wallet.built[0].getHash())
  })

  // --- two-drive concurrency (deterministic barriers, 5x) ----------------------

  test.each([0, 1, 2, 3, 4])('two concurrent cron drives contending on one queued payout produce exactly one relay (run %i)', async () => {
    const payout = await seedPayout()
    const walletA = makeWallet()
    const walletB = makeWallet()

    // Deterministic barrier: both drives must finish building (relay:false)
    // before either prepares, so the store's unique per-leg dispatch serializes
    // the contention instead of test timing.
    let built = 0
    let releaseBuilt
    const bothBuilt = new Promise(resolve => { releaseBuilt = resolve })
    for (const wallet of [walletA, walletB]) {
      const inner = wallet.createTx.getMockImplementation()
      wallet.createTx.mockImplementation(async req => {
        built += 1
        if (built === 2) releaseBuilt()
        await bothBuilt
        return inner(req)
      })
    }

    const options = { models: db, keyProvider }
    const [summaryA, summaryB] = await Promise.all([
      sendBountyPayments([payout], { ...options, wallet: walletA }),
      sendBountyPayments([payout], { ...options, wallet: walletB })
    ])

    const relays = walletA.relayTx.mock.calls.length + walletB.relayTx.mock.calls.length
    expect(relays).toBe(1)
    const winner = summaryA.sent === 1 ? walletA : walletB
    const loser = summaryA.sent === 1 ? summaryB : summaryA
    expect(loser).toMatchObject({ sent: 0, failed: 0 })

    const row = await db.bountyPayment.findUnique({ where: { id: payout.id } })
    expect(row.state).toBe('SENT')
    expect(row.txHash).toBe(winner.built[0].getHash())
    expect(await db.escrowWalletTransaction.count({ where: { bountyPaymentId: payout.id, leg: 'DISPOSITION' } })).toBe(1)
  })

  // --- stop BEFORE relay --------------------------------------------------------

  test('a missing fee destination stops before any build or relay (payout left QUEUED)', async () => {
    const payout = await seedPayout({ feeRecipientAddress: null })
    const wallet = makeWallet()
    delete process.env.REWARDS_COLD_STORAGE_ADDRESS
    try {
      const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })
      expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, settled: 0 })
    } finally {
      process.env.REWARDS_COLD_STORAGE_ADDRESS = COLD
    }
    expect(wallet.createTx).not.toHaveBeenCalled()
    expect(wallet.relayTx).not.toHaveBeenCalled()
    const row = await db.bountyPayment.findUnique({ where: { id: payout.id } })
    expect(row.state).toBe('QUEUED')
    expect(row.feeRecipientAddress).toBeNull()
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ payoutId: payout.id }),
      expect.stringContaining('no escrow fee destination configured')
    )
  })

  test('shared prize and fee address dispatch succeeds with both frozen obligations', async () => {
    const payout = await seedPayout({ recipientAddress: A, feeRecipientAddress: A })
    const wallet = makeWallet()

    const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })

    expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, settled: 0 })
    expect(wallet.createTx).toHaveBeenCalledTimes(1) // built relay:false...
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)
    const row = await db.bountyPayment.findUnique({ where: { id: payout.id } })
    expect(row.state).toBe('SENT')
    expect(row.txHash).not.toBeNull()
    expect(row.recipientReceivedPiconeros).toBe(payout.piconeros)
    expect(row.feeReceivedPiconeros + row.networkFeePiconeros).toBe(payout.feePiconeros)
  })

  test('changed frozen terms stop preparation before relay: a stale caller expectation conflicts with the row', async () => {
    const payout = await seedPayout({ feeRecipientAddress: COLD })
    const wallet = makeWallet()
    const destinations = [
      { address: A, amount: payout.piconeros },
      { address: COLD, amount: payout.feePiconeros }
    ]
    const tx = await wallet.createTx({ accountIndex: 0, destinations, subtractFeeFrom: [1], relay: false })
    const settlement = await readBountySettlement(tx, { payout, feeRecipientAddress: COLD })
    // A stale expectation (the prize changed after the built tx was planned)
    // must conflict inside the store's Serializable re-validation — never
    // silently dispatch against changed terms.
    const stale = { ...payout, piconeros: payout.piconeros - 1n }
    await expect(prepareEscrowTransaction({
      models: db, wallet, tx, payout: stale, leg: 'DISPOSITION', settlement, scope: SCOPE, keyProvider
    })).rejects.toThrow(/PAYMENT_PROOF_OWNER_CONFLICT/)
    expect(await db.escrowWalletTransaction.count()).toBe(0)
    expect(wallet.relayTx).not.toHaveBeenCalled()
  })

  test('a fee-destination persist failure before dispatch leaves the payout QUEUED and dispatches nothing', async () => {
    const payout = await seedPayout({ feeRecipientAddress: null })
    const models = withFaultyPayoutUpdate(
      args => args?.[0]?.data?.feeRecipientAddress === COLD,
      async () => { throw new Error('transient db blip') }
    )
    const wallet = makeWallet()

    const summary = await sendBountyPayments([payout], { models, wallet, keyProvider })

    expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, settled: 0 })
    expect(wallet.createTx).not.toHaveBeenCalled()
    const row = await db.bountyPayment.findUnique({ where: { id: payout.id } })
    expect(row.state).toBe('QUEUED')
    expect(row.feeRecipientAddress).toBeNull()
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ payoutId: payout.id, errorClass: expect.any(String) }),
      expect.stringContaining('before dispatch')
    )
  })

  // --- rollover / fee-waived single-net-output contracts ------------------------

  test('ROLLOVER keeps the single-net-output contract and writes no hot-wallet receipt', async () => {
    const payout = await seedPayout({ kind: 'ROLLOVER', piconeros: ROLLOVER_PRIZE, feePiconeros: 0n })
    const wallet = makeWallet({ unlocked: ROLLOVER_PRIZE })

    const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })

    expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0, settled: 0 })
    expect(wallet.createTx.mock.calls[0][0]).toMatchObject({
      destinations: [{ address: A, amount: ROLLOVER_PRIZE }],
      subtractFeeFrom: [0],
      relay: false
    })
    const row = await db.bountyPayment.findUnique({ where: { id: payout.id } })
    // Funded rollover receipt attribution is unchanged: the whole net output is
    // the recipient receipt with a zero fee receipt; the split from the
    // separately frozen booked prize happens at confirmed-receipt attribution.
    expect(row.networkFeePiconeros).toBe(NET_FEE)
    expect(row.recipientReceivedPiconeros).toBe(ROLLOVER_PRIZE - NET_FEE)
    expect(row.feeReceivedPiconeros).toBe(0n)
    expect(row.state).toBe('SENT')
    // No relay-time hot-wallet revenue: escrow fees never enter the hot-wallet
    // expense union and no FeeObservation is written at relay.
    expect(await db.feeObservation.count()).toBe(0)
  })

  // --- prepare/claim barrier semantics ------------------------------------------

  test('a durable-but-unattempted pair reserves its leg: the next drive neither builds nor relays', async () => {
    const payout = await seedPayout({ feeRecipientAddress: COLD })
    const { journal } = await prepareDisposition({ payout })
    expect(journal.state).toBe('PREPARED')
    expect(journal.relayAttemptedAt).toBeNull()

    const wallet = makeWallet()
    const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })

    expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, settled: 0 })
    expect(wallet.createTx).not.toHaveBeenCalled() // reserved from rebuilding
    expect(wallet.relayTx).not.toHaveBeenCalled()
    const row = await db.bountyPayment.findUnique({ where: { id: payout.id } })
    expect(row.state).toBe('QUEUED')
    expect(alert).toHaveBeenCalledWith(
      'critical',
      'bounty escrow pair reserved (durable but unattempted)',
      expect.stringContaining('provably unbroadcast'),
      expect.objectContaining({ dedupeKey: `escrow-pair-unattempted-${journal.txHash}` })
    )
  })

  test('an attempt-CAS conflict (a concurrent drive claimed the attempt) relays nothing', async () => {
    const payout = await seedPayout({ feeRecipientAddress: COLD })
    const { journal } = await prepareDisposition({ payout })
    await markAttempted(journal.id)
    const wallet = makeWallet()

    const summary = await sendBountyPayments([payout], { models: db, wallet, keyProvider })

    expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, settled: 0 })
    expect(wallet.relayTx).not.toHaveBeenCalled()
    expect((await db.bountyPayment.findUnique({ where: { id: payout.id } })).state).toBe('QUEUED')
  })

  test('relayEscrowTransaction refuses a journaled hash mismatch before the attempt is burned', async () => {
    const payout = await seedPayout({ feeRecipientAddress: COLD })
    const { journal, tx, wallet } = await prepareDisposition({ payout })
    const other = makeWallet()
    const otherTx = await other.createTx({ accountIndex: 0, destinations: [{ address: A, amount: payout.piconeros }], subtractFeeFrom: [0], relay: false })
    await expect(relayEscrowTransaction({ models: db, wallet, journal, tx: otherTx, keyProvider }))
      .rejects.toThrow(/does not match the journaled hash/)
    expect(wallet.relayTx).not.toHaveBeenCalled()
    expect(other.relayTx).not.toHaveBeenCalled()
    expect((await db.escrowWalletTransaction.findUnique({ where: { id: journal.id } })).relayAttemptedAt).toBeNull()
    // The journaled object still relays exactly once afterwards.
    await relayEscrowTransaction({ models: db, wallet, journal, tx, keyProvider })
    expect(wallet.relayTx).toHaveBeenCalledTimes(1)
    expect(tx.getHash()).toBe(journal.txHash)
  })

  // --- reconciliation: fresh verified resolution of attempted uncertainty -------

  test('pending recorded escrow candidate does not poison confirmed dispatch recovery', async () => {
    const payout = await seedPayout({ piconeros: 40n, feePiconeros: 20n, feeRecipientAddress: COLD })
    const { journal, tx } = await prepareDisposition({ payout, wallet: makeWallet({ netFee: 7n }) })
    await markAttempted(journal.id)
    const other = await seedPayout({ piconeros: 40n, feePiconeros: 20n, feeRecipientAddress: COLD })
    const otherDispatch = await prepareDisposition({ payout: other, wallet: makeWallet({ netFee: 7n }) })
    const pending = otherDispatch.journal.txHash
    const audit = localEscrowAuditChain({ tx })
    const original = audit.daemon.getPaymentTransactions.getMockImplementation()
    audit.daemon.getPaymentTransactions.mockImplementation(async hashes => {
      if (hashes.includes(pending)) { const err = new Error('synthetic pool refusal'); err.code = 'RAW_TX_IN_POOL'; throw err }
      return original(hashes)
    })
    const result = await reconcileEscrowTransactions({ models: db, wallet: makeWallet(), scope: SCOPE, daemon: audit.daemon, auditWallet: audit.wallet, keyProvider })
    expect(result.recoveredIds).toEqual([payout.id])
  })

  test('account-0-only escrow runtime recovers without provisioning rewards fee accounts', async () => {
    const payout = await seedPayout({ piconeros: 40n, feePiconeros: 20n, feeRecipientAddress: COLD })
    const { journal, tx } = await prepareDisposition({ payout, wallet: makeWallet({ netFee: 7n }) })
    await markAttempted(journal.id)
    const audit = localEscrowAuditChain({ tx })
    audit.wallet.getAccounts.mockResolvedValue([{ getIndex: () => 0 }])
    audit.wallet.getAddress.mockImplementation(async (major, minor) => major === 0 && minor === 0 ? WADDR : undefined)
    audit.wallet.createAccount = jest.fn(() => { throw new Error('escrow must not provision rewards accounts') })
    const result = await reconcileEscrowTransactions({ models: db, wallet: makeWallet(), scope: SCOPE, daemon: audit.daemon, auditWallet: audit.wallet, keyProvider })
    expect(result.recoveredIds).toEqual([payout.id])
    expect(audit.wallet.createAccount).not.toHaveBeenCalled()
  })

  test.each(['receipt', 'promotion'])('moving tip during escrow %s refuses or rolls back promotion', async phase => {
    const payout = await seedPayout({ piconeros: 40n, feePiconeros: 20n, feeRecipientAddress: COLD })
    const { journal, tx } = await prepareDisposition({ payout, wallet: makeWallet({ netFee: 7n }) })
    await markAttempted(journal.id)
    const audit = localEscrowAuditChain({ tx })
    const height = await audit.daemon.getHeight()
    let moved = false
    audit.daemon.getHeight.mockImplementation(async () => height + (moved ? 1 : 0))
    const oldCheck = audit.wallet.checkTxKey
    audit.wallet.checkTxKey = async (...args) => {
      const receipt = await oldCheck(...args)
      if (phase === 'receipt') moved = true
      return receipt
    }
    const models = new Proxy(db, {
      get: (target, property) => property === '$transaction'
        ? (callback, options) => target.$transaction(client => callback(new Proxy(client, {
            get: (tx, key) => key === 'escrowWalletTransaction'
              ? new Proxy(tx[key], {
                get: (model, method) => method === 'updateMany'
                  ? async (...args) => { const result = await model.updateMany(...args); if (phase === 'promotion') moved = true; return result }
                  : model[method]
              })
              : tx[key]
          })), options)
        : target[property]
    })
    const result = await reconcileEscrowTransactions({ models, wallet: makeWallet(), scope: SCOPE, daemon: audit.daemon, auditWallet: audit.wallet, keyProvider })
    expect((await db.escrowWalletTransaction.findUnique({ where: { id: journal.id } })).state).toBe('PREPARED')
    expect(result.recoveredIds).toEqual([])
  })

  test('runtime escrow requests audited dispatch hash with no owned payment outputs', async () => {
    const payout = await seedPayout({ piconeros: 40n, feePiconeros: 20n, feeRecipientAddress: COLD })
    const { journal, tx } = await prepareDisposition({ payout, wallet: makeWallet({ netFee: 7n }) })
    await markAttempted(journal.id)
    const audit = localEscrowAuditChain({ tx })
    const rows = await audit.wallet.getOutputs()
    audit.wallet.getOutputs.mockResolvedValue(rows.filter(row => row.getTx().getHash() !== journal.txHash))
    await reconcileEscrowTransactions({ models: db, wallet: makeWallet(), scope: SCOPE, daemon: audit.daemon, auditWallet: audit.wallet, keyProvider })
    expect(audit.daemon.getPaymentTransactions.mock.calls.flatMap(([hashes]) => hashes)).toContain(journal.txHash)
  })

  test('derives recorded unexposed account-0 minor before runtime escrow scan', async () => {
    const payout = await seedPayout({ piconeros: 40n, feePiconeros: 20n, feeRecipientAddress: COLD })
    const { journal, tx } = await prepareDisposition({ payout, wallet: makeWallet({ netFee: 7n }) })
    await markAttempted(journal.id)
    const audit = localEscrowAuditChain({ tx })
    const minorAddress = makeAddress(1401)
    let derived = false
    const oldAddress = audit.wallet.getAddress
    audit.wallet.getAddress = async (major, minor) => major === 0 && minor === 1
      ? (derived ? minorAddress : undefined)
      : oldAddress(major, minor)
    audit.wallet.getSubaddresses = async major => Array.from({ length: major === 0 && derived ? 2 : 1 }, (_, minor) => ({ getAddress: () => major === 0 && minor === 1 ? minorAddress : null }))
    audit.wallet.createSubaddress = async major => { if (major === 0) derived = true }
    const oldOutputs = audit.wallet.getOutputs
    audit.wallet.getOutputs = async () => {
      expect(derived).toBe(true)
      return oldOutputs()
    }
    const models = new Proxy(db, {
      get: (target, property) => property === 'subaddressIndex'
        ? { findMany: async () => [{ majorIndex: 0, minorIndex: 1, address: minorAddress }] }
        : target[property]
    })
    const result = await reconcileEscrowTransactions({ models, wallet: makeWallet(), scope: SCOPE, daemon: audit.daemon, auditWallet: audit.wallet, keyProvider })
    expect(derived).toBe(true)
    expect(result.recoveredIds).toEqual([payout.id])
  })

  test('an attempted dispatch resolves ONLY via a fresh confirmed verification: promotion + settlement recovery', async () => {
    const payout = await seedPayout({ piconeros: 40n, feePiconeros: 20n, feeRecipientAddress: COLD })
    const { journal, tx } = await prepareDisposition({ payout, wallet: makeWallet({ netFee: 7n }) })
    await markAttempted(journal.id)

    // No audit session (env keys absent): uncertainty is retained, never guessed.
    const withheld = await reconcileEscrowTransactions({ models: db, wallet: makeWallet(), scope: SCOPE, keyProvider })
    expect(withheld.withheldDispositionIds).toEqual([payout.id])
    expect(withheld.recoveredIds).toEqual([])
    expect(withheld.accountingUnpersisted).toBeGreaterThan(0)
    expect((await db.escrowWalletTransaction.findUnique({ where: { id: journal.id } })).state).toBe('PREPARED')

    // A dedicated genesis-restored audit session (injected fake audit wallet +
    // fake daemon through the real collector/verifier seam) proves the relay.
    const audit = localEscrowAuditChain({ tx })
    const result = await reconcileEscrowTransactions({
      models: db, wallet: makeWallet(), scope: SCOPE, daemon: audit.daemon, auditWallet: audit.wallet, keyProvider
    })

    expect(result.accountingUnpersisted).toBe(0)
    expect(result.recoveredIds).toEqual([payout.id])
    expect(result.withheldDispositionIds).toEqual([payout.id]) // durable RELAYED withholds too
    const stored = await db.escrowWalletTransaction.findUnique({ where: { id: journal.id } })
    expect(stored.state).toBe('RELAYED')
    expect(stored.relayProvenance).toBe('chain-proof-observation')
    const row = await db.bountyPayment.findUnique({ where: { id: payout.id } })
    expect(row.state).toBe('SENT')
    expect(row.txHash).toBe(journal.txHash)
    expect(row.networkFeePiconeros).toBe(7n)
    expect(row.recipientReceivedPiconeros).toBe(40n)
    expect(row.feeReceivedPiconeros).toBe(13n)
  })

  test('a rollover attempted dispatch fresh-verifies with its single net member', async () => {
    const payout = await seedPayout({ kind: 'ROLLOVER', piconeros: 40n, feePiconeros: 0n })
    const { journal, tx } = await prepareDisposition({ payout, wallet: makeWallet({ netFee: 7n }) })
    await markAttempted(journal.id)
    const audit = localEscrowAuditChain({ tx })

    const result = await reconcileEscrowTransactions({
      models: db, wallet: makeWallet(), scope: SCOPE, daemon: audit.daemon, auditWallet: audit.wallet, keyProvider
    })

    expect(result.recoveredIds).toEqual([payout.id])
    const row = await db.bountyPayment.findUnique({ where: { id: payout.id } })
    expect(row.state).toBe('SENT')
    expect(row.recipientReceivedPiconeros).toBe(40n - 7n)
    expect(row.feeReceivedPiconeros).toBe(0n)
  })

  test('a legacy separate-fee attempted dispatch fresh-verifies with the full frozen fee member', async () => {
    const payout = await seedPayout({ state: 'SENT', txHash: PRIZE_HASH, feePiconeros: 20n, feePendingAt: LEGACY_PENDING_AT, feeRecipientAddress: COLD })
    const { journal, tx } = await prepareLegacyFee({ payout, wallet: makeWallet({ netFee: 7n }) })
    await markAttempted(journal.id)
    const audit = localEscrowAuditChain({ tx })

    const result = await reconcileEscrowTransactions({
      models: db, wallet: makeWallet(), scope: SCOPE, daemon: audit.daemon, auditWallet: audit.wallet, keyProvider
    })

    expect(result.recoveredIds).toEqual([payout.id])
    expect(result.withheldFeeIds).toEqual([payout.id])
    expect(result.withheldDispositionIds).toEqual([])
    const stored = await db.escrowWalletTransaction.findUnique({ where: { id: journal.id } })
    expect(stored.state).toBe('RELAYED')
    expect(stored.leg).toBe('LEGACY_SEPARATE_FEE')
    const row = await db.bountyPayment.findUnique({ where: { id: payout.id } })
    expect(row.feeTxHash).toBe(journal.txHash)
    expect(row.feePendingAt).toBeNull()
    expect(row.feeSettlementNetworkFeePiconeros).toBe(7n)
    expect(row.feeReceivedPiconeros).toBe(20n)
    // The prize leg is untouched.
    expect(row.txHash).toBe(PRIZE_HASH)
    expect(row.state).toBe('SENT')
  })

  // --- reconciliation: durable DB-only recovery (no keys, no chain) --------------

  test('durable RELAYED disposition recovers settlement facts DB-only even with lost proof keys (never a re-send)', async () => {
    const payout = await seedPayout({ piconeros: 40n, feePiconeros: 20n, feeRecipientAddress: COLD })
    const wallet = makeWallet({ netFee: 7n })
    const { journal, tx } = await prepareDisposition({ payout, wallet })
    // The relay succeeded but the payout persist failed: the journal is
    // RELAYED, the payout row is still QUEUED.
    await relayEscrowTransaction({ models: db, wallet, journal, tx, keyProvider })
    expect((await loadJournal(payout.id)).state).toBe('RELAYED')
    expect((await db.bountyPayment.findUnique({ where: { id: payout.id } })).state).toBe('QUEUED')

    // A later drive holds LOST proof keys: the DB-only recovery still runs, and
    // the already-broadcast payout is never built or relayed again.
    const later = makeWallet()
    const summary = await sendBountyPayments([payout], { models: db, wallet: later, keyProvider: lostKeyProvider })

    expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0, settled: 0 })
    expect(later.createTx).not.toHaveBeenCalled()
    expect(later.relayTx).not.toHaveBeenCalled()
    const row = await db.bountyPayment.findUnique({ where: { id: payout.id } })
    expect(row.state).toBe('SENT')
    expect(row.txHash).toBe(journal.txHash)
    expect(row.networkFeePiconeros).toBe(7n)
    expect(row.recipientReceivedPiconeros).toBe(40n)
    expect(row.feeReceivedPiconeros).toBe(13n)
  })

  test('durable RELAYED separate fee recovers the fee facts DB-only (feeTxHash set once, feePendingAt cleared)', async () => {
    const payout = await seedPayout({ state: 'SENT', txHash: PRIZE_HASH, feePiconeros: 20n, feePendingAt: LEGACY_PENDING_AT, feeRecipientAddress: COLD })
    const wallet = makeWallet({ netFee: 7n })
    const { journal, tx } = await prepareLegacyFee({ payout, wallet })
    await relayEscrowTransaction({ models: db, wallet, journal, tx, keyProvider })
    expect((await loadJournal(payout.id)).state).toBe('RELAYED')

    const result = await reconcileEscrowTransactions({ models: db, wallet: makeWallet(), scope: SCOPE, keyProvider: lostKeyProvider })

    expect(result.recoveredIds).toEqual([payout.id])
    expect(result.withheldFeeIds).toEqual([payout.id])
    const row = await db.bountyPayment.findUnique({ where: { id: payout.id } })
    expect(row.feeTxHash).toBe(journal.txHash)
    expect(row.feePendingAt).toBeNull()
    expect(row.feeSettlementNetworkFeePiconeros).toBe(7n)
    expect(row.feeReceivedPiconeros).toBe(20n)
    expect(row.state).toBe('SENT')
    // The prize was never re-sent by recovery.
    expect(row.txHash).toBe(PRIZE_HASH)
  })

  test('a durable RELAYED dispatch never overwrites an already-recorded MISMATCHING hash (withheld + alert)', async () => {
    const payout = await seedPayout({ piconeros: 40n, feePiconeros: 20n, feeRecipientAddress: COLD })
    const wallet = makeWallet({ netFee: 7n })
    const { journal, tx } = await prepareDisposition({ payout, wallet })
    await relayEscrowTransaction({ models: db, wallet, journal, tx, keyProvider })
    // The row recorded a DIFFERENT transaction after the proven relay.
    const foreignHash = 'ff'.repeat(32)
    await db.bountyPayment.update({ where: { id: payout.id }, data: { state: 'SENT', txHash: foreignHash } })

    const result = await reconcileEscrowTransactions({ models: db, wallet: makeWallet(), scope: SCOPE, keyProvider })

    expect(result.recoveredIds).toEqual([])
    expect(result.withheldDispositionIds).toEqual([payout.id])
    expect(result.accountingUnpersisted).toBeGreaterThan(0)
    const row = await db.bountyPayment.findUnique({ where: { id: payout.id } })
    expect(row.txHash).toBe(foreignHash) // never overwritten
    expect(alert).toHaveBeenCalledWith(
      'critical',
      'bounty escrow settlement recovery withheld',
      expect.stringContaining('recorded transaction hash mismatch'),
      expect.any(Object)
    )
  })

  test('a durable RELAYED dispatch never rewrites a FAILED row (withheld + alert)', async () => {
    const payout = await seedPayout({ piconeros: 40n, feePiconeros: 20n, feeRecipientAddress: COLD })
    const wallet = makeWallet({ netFee: 7n })
    const { journal, tx } = await prepareDisposition({ payout, wallet })
    await relayEscrowTransaction({ models: db, wallet, journal, tx, keyProvider })
    await db.bountyPayment.update({ where: { id: payout.id }, data: { state: 'FAILED' } })

    const result = await reconcileEscrowTransactions({ models: db, wallet: makeWallet(), scope: SCOPE, keyProvider })

    expect(result.recoveredIds).toEqual([])
    expect(result.withheldDispositionIds).toEqual([payout.id])
    expect(result.accountingUnpersisted).toBeGreaterThan(0)
    expect((await db.bountyPayment.findUnique({ where: { id: payout.id } })).state).toBe('FAILED')
    expect(alert).toHaveBeenCalledWith(
      'critical',
      'bounty escrow settlement recovery withheld',
      expect.stringContaining('relayed proof contradicts a FAILED row'),
      expect.any(Object)
    )
  })

  // Read-boundary tampering: the Task 3 immutability trigger (correctly) refuses
  // an out-of-band UPDATE of captured facts, so the tampered capture is
  // simulated at the read boundary — the recovery gate must reject a claims
  // blob whose digest no longer matches the immutable journal digest.
  const withTamperedEscrowClaims = prizePiconeros => new Proxy(db, {
    get (inner, prop) {
      if (prop !== 'escrowWalletTransaction') {
        const value = Reflect.get(inner, prop, inner)
        return typeof value === 'function' ? value.bind(inner) : value
      }
      const delegate = Reflect.get(inner, prop, inner)
      return new Proxy(delegate, {
        get (innerDelegate, modelProp) {
          const value = Reflect.get(innerDelegate, modelProp, innerDelegate)
          if (modelProp === 'findMany') {
            return async (...args) => (await value.apply(innerDelegate, args)).map(row => ({
              ...row,
              paymentClaims: {
                ...row.paymentClaims,
                frozenTerms: { ...row.paymentClaims.frozenTerms, prizePiconeros }
              }
            }))
          }
          return typeof value === 'function' ? value.bind(innerDelegate) : value
        }
      })
    }
  })

  test('a tampered capture is withheld, never authorizes a payout write', async () => {
    const payout = await seedPayout({ piconeros: 40n, feePiconeros: 20n, feeRecipientAddress: COLD })
    const wallet = makeWallet({ netFee: 7n })
    const { journal, tx } = await prepareDisposition({ payout, wallet })
    await relayEscrowTransaction({ models: db, wallet, journal, tx, keyProvider })

    const result = await reconcileEscrowTransactions({
      models: withTamperedEscrowClaims('41'), wallet: makeWallet(), scope: SCOPE, keyProvider
    })

    expect(result.recoveredIds).toEqual([])
    expect(result.withheldDispositionIds).toEqual([payout.id])
    expect(result.accountingUnpersisted).toBeGreaterThan(0)
    expect((await db.bountyPayment.findUnique({ where: { id: payout.id } })).state).toBe('QUEUED')
    // The journal/claims themselves were never rewritten by recovery.
    const stored = await db.escrowWalletTransaction.findUnique({ where: { id: journal.id } })
    expect(stored.paymentClaims.frozenTerms.prizePiconeros).toBe('40')
  })

  // --- secrecy -----------------------------------------------------------------

  test('reconciliation diagnostics never leak chain evidence or key material', async () => {
    const payout = await seedPayout({ piconeros: 40n, feePiconeros: 20n, feeRecipientAddress: COLD })
    const { journal, tx } = await prepareDisposition({ payout, wallet: makeWallet({ netFee: 7n }) })
    await markAttempted(journal.id)
    const audit = localEscrowAuditChain({ tx })
    await reconcileEscrowTransactions({
      models: db, wallet: makeWallet(), scope: SCOPE, daemon: audit.daemon, auditWallet: audit.wallet, keyProvider
    })
    const logged = [
      ...logInfo.mock.calls.map(call => JSON.stringify(call)),
      ...logWarn.mock.calls.map(call => JSON.stringify(call)),
      ...logError.mock.calls.map(call => JSON.stringify(call)),
      ...alert.mock.calls.map(call => JSON.stringify(call))
    ]
    for (const entry of logged) {
      expect(entry).not.toMatch(/keyBundleHex|mainPublicKey|stealthPublicKey|keyImage|ciphertext|wrappedDek|dataNonce|paymentClaims/)
    }
  })
})
