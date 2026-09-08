/* eslint-env jest */

// Integration tests for the Monero resolvers (spec §4.5, §7.3).
//
// registerMoneroAccount is the wallet-onboarding mutation: it validates the
// stagenet address + private view key via monero-ts (real validation, NOT
// mocked), encrypts the view key (Task 2 envelope), registers the account
// with monero-lws, and persists MoneroAccount / MoneroViewKey rows + sets
// User.privacyMode.
//
// initiateTip starts a P2P tip: it derives an integrated address from the
// post author's primary address + a payment ID, registers a lws webhook, and
// creates a PENDING ObservedTip.
//
// The lwsClient is the only mock — it is the network boundary (DI seam on the
// Apollo `monero` context). Everything else is real DB behaviour against a
// live, migrated database.

import { PrismaClient } from '@prisma/client'
import resolvers from '@/api/resolvers/monero'
import { LwsHttpError } from '@/api/monero/lwsClient'
import { sweepFakeRewardsWallets } from '../../helpers/sweepRewardsWallets'

process.env.VIEWKEY_MASTER_KEY = Buffer.from('a'.repeat(32)).toString('base64')
process.env.MONERO_NETWORK = 'stagenet'
process.env.LWS_WEBHOOK_URL = 'http://app:3000/api/monero/webhook'

const prisma = new PrismaClient()

const STAGENET_ADDR = '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'
const STAGENET_VIEWKEY = '5580e0440c77c9b720950defd0bcfbd87b6a10f098ed345fac290c7f48b3c60e'
// Checksum-valid fixtures (see test/api/monero/primaryAddress.test.js). Both
// PASS MoneroUtils.isValidAddress(·, STAGENET) — only the class byte differs.
const STAGENET_INTEG = '5JAfPMqsvw2JfTsaZvHyWFadMp3GTVNPL2jU66DV47BZGUEAUBzpkVvSZ1uaziDT2mgXZAymK9U9aNhSxc63ARKahkXrmRbwLFY3pV5qUc'
const STAGENET_SUB = '76xWgnfS349P5LUqFTQx3DWMgUHcXutpY3ZyHsnz2vx3HiWVj6NKwmsjBnH3MbnpDcDGUkzYAawcG9CaUamznCrfPCyVgd1'
const MAINNET_PRIMARY = '4B9ryEY64fSPjveaDX3dwhcyeYcYtemZ2gHfxg7VeLyR7SS4BbZfgzdVRH46NzB2DpHdhVkegdoP1hG8iWL3HZkQC5WyT1H'
// View-key pairing fixtures: PUB is the public view key embedded in
// STAGENET_ADDR (base58xmr-decoded bytes[33:65] — base58xmr.decode verified),
// OTHER_PRIV is a different stagenet wallet's private view key.
const STAGENET_PUB_VK = '4c86a16498b9c45073b1cd0368d852e3f4e82c7afcda732b5e69c0e97dd5b40b'
const OTHER_PRIV_VK = '3852db1c09acb1178a484e28d878bb3539f9e10f94d8a7649927f235a35d930a'

function makeMockLws () {
  return {
    addAccount: jest.fn().mockResolvedValue({}),
    addWebhook: jest.fn().mockResolvedValue({ event_id: 'evt-test-1' }),
    modifyAccountStatus: jest.fn().mockResolvedValue({ updated: [] }),
    deleteAddressWebhooks: jest.fn().mockResolvedValue({})
  }
}

const created = { users: [], accounts: [], items: [], tips: [] }

async function cleanupTracked () {
  await prisma.observedTip.deleteMany({ where: { recipientAccountId: { in: created.accounts } } })
  await prisma.subaddressIndex.deleteMany({ where: { accountId: { in: created.accounts } } })
  await prisma.moneroViewKey.deleteMany({ where: { accountId: { in: created.accounts } } })
  await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
  await prisma.item.deleteMany({ where: { id: { in: created.items } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  created.users.length = 0
  created.accounts.length = 0
  created.items.length = 0
  created.tips.length = 0
}

afterEach(cleanupTracked)
beforeAll(async () => {
  await sweepFakeRewardsWallets([REWARDS_ADDR])
})
afterAll(async () => {
  await cleanupTracked()
  await sweepFakeRewardsWallets([REWARDS_ADDR])
  await prisma.$disconnect()
})

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  const id = rows[0].id
  created.users.push(id)
  return id
}

async function createPost (userId) {
  const item = await prisma.item.create({
    data: { userId, title: 'test post for tipping', status: 'ACTIVE' }
  })
  created.items.push(item.id)
  return item
}

async function registerFor (userId, overrides = {}, lws = makeMockLws()) {
  const acct = await resolvers.Mutation.registerMoneroAccount(null, {
    address: STAGENET_ADDR,
    viewKey: STAGENET_VIEWKEY,
    privacyMode: 'AUTO_INDEX',
    ...overrides
  }, { me: { id: userId }, models: prisma, monero: lws })
  created.accounts.push(acct.id)
  return { acct, lws }
}

// Unique placeholder address. Valid base58 (no 0/O/I/l) and 99 chars = 9 full
// 11-char base58xmr blocks, so makeIntegratedAddress decodes it without error.
const REWARDS_ADDR = '5Base58TipRedirect' + '1'.repeat(81) // unique stagenet placeholder

async function createRewardsWallet () {
  // initiateTipCore resolves the rewards wallet via findFirst (lowest id), and the
  // live dev DB may already hold a registered platform_rewards row (seeded by
  // `sndev monero register-rewards-wallet`, e.g. account 120). Insert this suite's
  // row with an id BELOW any existing account so the resolver deterministically
  // resolves OUR row; without this the redirect test would assert against the
  // seeded row instead and its afterEach cleanup would miss the ObservedTip
  // (recipientAccountId outside created.accounts), cascading FK failures.
  const lowest = await prisma.moneroAccount.findFirst({ orderBy: { id: 'asc' } })
  const acct = await prisma.moneroAccount.create({
    data: {
      id: lowest ? lowest.id - 1 : undefined,
      ownerUserId: null,
      address: REWARDS_ADDR,
      label: 'platform_rewards',
      network: 'STAGENET',
      status: 'ACTIVE'
    }
  })
  created.accounts.push(acct.id)
  return acct
}

describe('Mutation.registerMoneroAccount', () => {
  test('validates, encrypts the view key, calls lws addAccount, sets User.privacyMode', async () => {
    const userId = await createUser()
    const { acct, lws } = await registerFor(userId)

    expect(acct.address).toBe(STAGENET_ADDR)
    expect(acct.label).toBe('author')
    expect(acct.network).toBe('STAGENET')

    expect(lws.addAccount).toHaveBeenCalledWith(STAGENET_ADDR, STAGENET_VIEWKEY)
    expect(lws.addAccount).toHaveBeenCalledTimes(1)

    const stored = await prisma.moneroViewKey.findUnique({ where: { accountId: acct.id } })
    expect(stored.ciphertext.toString('hex')).not.toContain(STAGENET_VIEWKEY)
    expect(stored.dekVersion).toBe(1)

    const user = await prisma.user.findUnique({ where: { id: userId } })
    expect(user.privacyMode).toBe('AUTO_INDEX')

    expect(resolvers.MoneroAccount.privacyMode(acct)).toBe('AUTO_INDEX')
  })

  test('rejects an invalid address and persists nothing', async () => {
    const userId = await createUser()
    const lws = makeMockLws()
    await expect(resolvers.Mutation.registerMoneroAccount(null, {
      address: 'not-a-real-monero-address',
      viewKey: STAGENET_VIEWKEY,
      privacyMode: 'AUTO_INDEX'
    }, { me: { id: userId }, models: prisma, monero: lws })).rejects.toThrow(/invalid monero address/i)

    expect(lws.addAccount).not.toHaveBeenCalled()
    expect(await prisma.moneroAccount.count({ where: { ownerUserId: userId } })).toBe(0)
  })

  test('rejects an invalid private view key', async () => {
    const userId = await createUser()
    const lws = makeMockLws()
    await expect(resolvers.Mutation.registerMoneroAccount(null, {
      address: STAGENET_ADDR,
      viewKey: 'garbage-not-a-view-key',
      privacyMode: 'AUTO_INDEX'
    }, { me: { id: userId }, models: prisma, monero: lws })).rejects.toThrow(/invalid monero private view key/i)
    expect(lws.addAccount).not.toHaveBeenCalled()
  })

  test.each([
    ['integrated', STAGENET_INTEG],
    ['subaddress', STAGENET_SUB]
  ])('rejects a same-network %s address before the lws call (class gap regression)', async (kind, address) => {
    const userId = await createUser()
    const lws = makeMockLws()
    await expect(resolvers.Mutation.registerMoneroAccount(null, {
      address,
      viewKey: STAGENET_VIEWKEY,
      privacyMode: 'AUTO_INDEX'
    }, { me: { id: userId }, models: prisma, monero: lws }))
      .rejects.toThrow(/use your wallet's primary address/i)

    expect(lws.addAccount).not.toHaveBeenCalled()
    expect(await prisma.moneroAccount.count({ where: { ownerUserId: userId } })).toBe(0)
  })

  test('network check fires before the class check (wrong-network primary gets the network message)', async () => {
    const userId = await createUser()
    const lws = makeMockLws()
    await expect(resolvers.Mutation.registerMoneroAccount(null, {
      address: MAINNET_PRIMARY,
      viewKey: STAGENET_VIEWKEY,
      privacyMode: 'AUTO_INDEX'
    }, { me: { id: userId }, models: prisma, monero: lws }))
      .rejects.toThrow(/invalid monero address for stagenet/i)
    expect(lws.addAccount).not.toHaveBeenCalled()
  })

  test('converts an lws add_account HTTP 500 into a user-facing input error (defense in depth)', async () => {
    const userId = await createUser()
    const lws = makeMockLws()
    // Post-validation a 500 escaping the client's idempotency fallback means
    // lws rejected the address outright (absent from list_accounts).
    lws.addAccount = jest.fn().mockRejectedValue(new LwsHttpError('https://lws/admin/add_account', 500))

    await expect(resolvers.Mutation.registerMoneroAccount(null, {
      address: STAGENET_ADDR,
      viewKey: STAGENET_VIEWKEY,
      privacyMode: 'AUTO_INDEX'
    }, { me: { id: userId }, models: prisma, monero: lws }))
      .rejects.toThrow(/the indexer rejected this address/i)

    expect(await prisma.moneroAccount.count({ where: { ownerUserId: userId } })).toBe(0)
  })

  test('propagates a list_accounts 500 from the idempotency fallback as unexpected (not an input error)', async () => {
    const userId = await createUser()
    const lws = makeMockLws()
    // addAccount's fallback probes list_accounts; a 500 from THAT endpoint
    // is an infra fault, not an address verdict — it must not be masked as
    // a user-facing input error.
    lws.addAccount = jest.fn().mockRejectedValue(new LwsHttpError('https://lws/admin/list_accounts', 500))

    await expect(resolvers.Mutation.registerMoneroAccount(null, {
      address: STAGENET_ADDR,
      viewKey: STAGENET_VIEWKEY,
      privacyMode: 'AUTO_INDEX'
    }, { me: { id: userId }, models: prisma, monero: lws }))
      .rejects.toThrow(/returned HTTP 500/)
    expect(await prisma.moneroAccount.count({ where: { ownerUserId: userId } })).toBe(0)
  })

  test('rejects a PUBLIC view key with a specific message (was: silent registration, tips never detected)', async () => {
    const userId = await createUser()
    const lws = makeMockLws()
    await expect(resolvers.Mutation.registerMoneroAccount(null, {
      address: STAGENET_ADDR,
      viewKey: STAGENET_PUB_VK,
      privacyMode: 'AUTO_INDEX'
    }, { me: { id: userId }, models: prisma, monero: lws }))
      .rejects.toThrow(/public view key/i)

    expect(lws.addAccount).not.toHaveBeenCalled()
    expect(await prisma.moneroAccount.count({ where: { ownerUserId: userId } })).toBe(0)
  })

  test("rejects another wallet's private view key (pairing mismatch)", async () => {
    const userId = await createUser()
    const lws = makeMockLws()
    await expect(resolvers.Mutation.registerMoneroAccount(null, {
      address: STAGENET_ADDR,
      viewKey: OTHER_PRIV_VK,
      privacyMode: 'AUTO_INDEX'
    }, { me: { id: userId }, models: prisma, monero: lws }))
      .rejects.toThrow(/does not match that address/i)

    expect(lws.addAccount).not.toHaveBeenCalled()
  })

  test('rejects if no me (GqlAuthenticationError)', async () => {
    await expect(resolvers.Mutation.registerMoneroAccount(null, {
      address: STAGENET_ADDR,
      viewKey: STAGENET_VIEWKEY,
      privacyMode: 'AUTO_INDEX'
    }, { models: prisma, monero: makeMockLws() })).rejects.toThrow(/you must be logged in/i)
  })

  test('defaults privacyMode to AUTO_INDEX when omitted', async () => {
    // Post-pivot there is only one detection model, so the resolver fills in
    // AUTO_INDEX when the caller does not pass privacyMode. registerFor
    // normally passes privacyMode: 'AUTO_INDEX'; overriding with undefined
    // exercises the default path.
    const userId = await createUser()
    await registerFor(userId, { privacyMode: undefined })

    const user = await prisma.user.findUnique({ where: { id: userId } })
    expect(user.privacyMode).toBe('AUTO_INDEX')
  })

  test('re-registers a wallet that was unregistered (upsert reuses the soft-deleted row)', async () => {
    const userId = await createUser()
    const { acct: first } = await registerFor(userId)

    // Unregister soft-deletes the row (ownerUserId -> null, status INACTIVE).
    await resolvers.Mutation.unregisterMoneroAccount(null, {}, { me: { id: userId }, models: prisma, monero: makeMockLws() })

    // Re-registering the same address must reuse the existing row, not collide
    // with the @@unique([address, network]) constraint.
    const { acct: second } = await registerFor(userId)
    expect(second.id).toBe(first.id)

    const stored = await prisma.moneroAccount.findUnique({ where: { id: second.id } })
    expect(stored.ownerUserId).toBe(userId)
    expect(stored.status).toBe('ACTIVE')

    const viewKey = await prisma.moneroViewKey.findUnique({ where: { accountId: second.id } })
    expect(viewKey).not.toBeNull()
  })

  test('rejects re-registering an ACTIVE address owned by another user (ownership guard)', async () => {
    const ownerId = await createUser()
    await registerFor(ownerId)
    const attackerId = await createUser()
    const lws = makeMockLws()

    await expect(resolvers.Mutation.registerMoneroAccount(null, {
      address: STAGENET_ADDR,
      viewKey: STAGENET_VIEWKEY,
      privacyMode: 'AUTO_INDEX'
    }, { me: { id: attackerId }, models: prisma, monero: lws }))
      .rejects.toThrow(/registered to another account/i)

    // lws addAccount ran first (lws-first ordering), but nothing local changed.
    expect(lws.addAccount).toHaveBeenCalledTimes(1)
    const stored = await prisma.moneroAccount.findFirst({ where: { address: STAGENET_ADDR } })
    expect(stored.ownerUserId).toBe(ownerId)
    expect(stored.status).toBe('ACTIVE')
  })
})

describe('Mutation.unregisterMoneroAccount', () => {
  test('flips lws account to inactive, deletes webhooks, wipes the view key, and detaches the row', async () => {
    const userId = await createUser()
    const { acct, lws } = await registerFor(userId)

    const result = await resolvers.Mutation.unregisterMoneroAccount(null, {}, { me: { id: userId }, models: prisma, monero: lws })
    expect(result).toBe(true)

    // lws FIRST: account set inactive, address webhooks deleted.
    expect(lws.modifyAccountStatus).toHaveBeenCalledWith([acct.address], 'inactive')
    expect(lws.deleteAddressWebhooks).toHaveBeenCalledWith(acct.address)

    // View key envelope wiped.
    expect(await prisma.moneroViewKey.findUnique({ where: { accountId: acct.id } })).toBeNull()

    // Soft-deleted: row retained, detached + inactive.
    const stored = await prisma.moneroAccount.findUnique({ where: { id: acct.id } })
    expect(stored.ownerUserId).toBeNull()
    expect(stored.status).toBe('INACTIVE')

    // myMoneroAccount now reports no account.
    expect(await resolvers.Query.myMoneroAccount(null, {}, { me: { id: userId }, models: prisma })).toBeNull()
  })

  test('returns false when the user has no registered account', async () => {
    const userId = await createUser()
    const lws = makeMockLws()
    const result = await resolvers.Mutation.unregisterMoneroAccount(null, {}, { me: { id: userId }, models: prisma, monero: lws })
    expect(result).toBe(false)
    expect(lws.modifyAccountStatus).not.toHaveBeenCalled()
  })

  test('aborts with an lws modifyAccountStatus failure, leaving the DB untouched', async () => {
    const userId = await createUser()
    const { acct } = await registerFor(userId)
    const lws = makeMockLws()
    lws.modifyAccountStatus = jest.fn().mockRejectedValue(new Error('lws down'))

    await expect(resolvers.Mutation.unregisterMoneroAccount(null, {}, { me: { id: userId }, models: prisma, monero: lws }))
      .rejects.toThrow('lws down')

    // lws FIRST invariant: a local failure must never outrun an lws failure —
    // view key intact, account still owned + ACTIVE.
    expect(await prisma.moneroViewKey.findUnique({ where: { accountId: acct.id } })).not.toBeNull()
    const stored = await prisma.moneroAccount.findUnique({ where: { id: acct.id } })
    expect(stored.ownerUserId).toBe(userId)
    expect(stored.status).toBe('ACTIVE')
  })

  test('resolves true and soft-deletes even when lws deleteAddressWebhooks fails (best-effort)', async () => {
    const userId = await createUser()
    const { acct } = await registerFor(userId)
    const lws = makeMockLws()
    lws.deleteAddressWebhooks = jest.fn().mockRejectedValue(new Error('webhook purge down'))

    const result = await resolvers.Mutation.unregisterMoneroAccount(null, {}, { me: { id: userId }, models: prisma, monero: lws })
    expect(result).toBe(true)

    // modifyAccountStatus succeeded -> local soft-delete proceeds despite the
    // best-effort webhook purge failing.
    expect(lws.modifyAccountStatus).toHaveBeenCalledWith([acct.address], 'inactive')
    expect(await prisma.moneroViewKey.findUnique({ where: { accountId: acct.id } })).toBeNull()
    const stored = await prisma.moneroAccount.findUnique({ where: { id: acct.id } })
    expect(stored.ownerUserId).toBeNull()
    expect(stored.status).toBe('INACTIVE')
  })

  test('rejects if no me (GqlAuthenticationError)', async () => {
    await expect(resolvers.Mutation.unregisterMoneroAccount(null, {}, { models: prisma, monero: makeMockLws() }))
      .rejects.toThrow(/you must be logged in/i)
  })
})

describe('Mutation.initiateTip', () => {
  test('generates a payment ID, integrated address, registers a webhook, and creates a PENDING ObservedTip', async () => {
    const authorId = await createUser()
    const { acct } = await registerFor(authorId)
    const post = await createPost(authorId)

    const tipperId = await createUser()
    const lws = makeMockLws()
    const result = await resolvers.Mutation.initiateTip(null, {
      postId: String(post.id),
      amount: '1000000000'
    }, { me: { id: tipperId }, models: prisma, monero: lws })

    // return value has the integrated address + payment ID + monero URI
    expect(result.integratedAddress).toMatch(/^5/)
    expect(result.integratedAddress).toHaveLength(106)
    expect(result.paymentId).toMatch(/^[0-9a-f]{16}$/)
    expect(result.uri).toContain(`monero:${result.integratedAddress}`)
    expect(result.recipient).toBe('AUTHOR')
    // tx_amount is DECIMAL XMR (Cake Wallet convention), not raw piconeros:
    // 1e9 piconeros == 0.001 XMR. Emitting raw piconeros here is the load-bearing bug.
    expect(result.uri).toContain('tx_amount=0.001')
    expect(result.uri).not.toMatch(/tx_amount=1000000000/)
    // Feather compatibility: an integrated-address URI must NOT also carry a
    // tx_payment_id param (Feather wallet2 parse_uri rejects that combination).
    expect(result.uri).not.toContain('tx_payment_id')

    // lws webhook registered with the author's address + payment ID
    expect(lws.addWebhook).toHaveBeenCalledTimes(1)
    const whArgs = lws.addWebhook.mock.calls[0][0]
    expect(whArgs.address).toBe(acct.address)
    expect(whArgs.paymentId).toBe(result.paymentId)
    expect(whArgs.confirmations).toBe(10)
    expect(whArgs.type).toBe('tx-confirmation')

    // ObservedTip created PENDING
    const tip = await prisma.observedTip.findFirst({
      where: { paymentId: result.paymentId },
      include: { recipientAccount: true }
    })
    expect(tip).not.toBeNull()
    expect(tip.state).toBe('PENDING')
    expect(tip.postId).toBe(post.id)
    expect(tip.tipperId).toBe(tipperId)
    expect(tip.piconeros).toBe(1000000000n)
    expect(tip.webhookEventId).toBe('evt-test-1')
    expect(tip.recipientAccountId).toBe(acct.id)
  })

  test('allows anonymous tippers: P2P tip with a null tipperId', async () => {
    const authorId = await createUser()
    const { acct } = await registerFor(authorId)
    const post = await createPost(authorId)
    const lws = makeMockLws()

    const result = await resolvers.Mutation.initiateTip(null, {
      postId: String(post.id),
      amount: '1000000000'
    }, { models: prisma, monero: lws })

    expect(result.paymentId).toMatch(/^[0-9a-f]{16}$/)
    expect(result.uri).toContain(`monero:${result.integratedAddress}`)
    expect(result.recipient).toBe('AUTHOR')
    expect(lws.addWebhook).toHaveBeenCalledTimes(1)

    // anonymous tips are stored with a null tipperId so they never earn curator
    // shares, streaks, or trust-weighted votes (the downstream pipeline keys on null)
    const tip = await prisma.observedTip.findFirst({ where: { paymentId: result.paymentId } })
    expect(tip).not.toBeNull()
    expect(tip.tipperId).toBeNull()
    expect(tip.postId).toBe(post.id)
    expect(tip.recipientAccountId).toBe(acct.id)
    expect(tip.state).toBe('PENDING')
    expect(tip.piconeros).toBe(1000000000n)
  })

  test('rejects if the post does not exist', async () => {
    const tipperId = await createUser()
    await expect(resolvers.Mutation.initiateTip(null, {
      postId: '9999999',
      amount: '1000000000'
    }, { me: { id: tipperId }, models: prisma, monero: makeMockLws() })).rejects.toThrow(/post not found/i)
  })

  test('rejects when the caller is the post author (direct self-tip gate)', async () => {
    const authorId = await createUser()
    await registerFor(authorId)
    const post = await createPost(authorId)
    const lws = makeMockLws()
    await expect(resolvers.Mutation.initiateTip(null, {
      postId: String(post.id),
      amount: '1000000000'
    }, { me: { id: authorId }, models: prisma, monero: lws }))
      .rejects.toThrow(/cannot tip your own post/i)
    expect(lws.addWebhook).not.toHaveBeenCalled()
    const count = await prisma.observedTip.count({ where: { postId: post.id } })
    expect(count).toBe(0)
  })

  test('redirects to the rewards wallet when the author has no MoneroAccount (wallet-less / anon)', async () => {
    const authorId = await createUser()
    const post = await createPost(authorId) // author has NO registered wallet
    const rewards = await createRewardsWallet()
    const tipperId = await createUser()
    const lws = makeMockLws()

    const result = await resolvers.Mutation.initiateTip(null, {
      postId: String(post.id),
      amount: '1000000000'
    }, { me: { id: tipperId }, models: prisma, monero: lws })

    // integrated address + payment ID + URI are derived from the REWARDS wallet
    expect(result.paymentId).toMatch(/^[0-9a-f]{16}$/)
    expect(result.uri).toContain(`monero:${result.integratedAddress}`)
    expect(result.recipient).toBe('REWARDS')

    // webhook registered against the rewards wallet's address
    expect(lws.addWebhook).toHaveBeenCalledTimes(1)
    expect(lws.addWebhook.mock.calls[0][0].address).toBe(rewards.address)

    // ObservedTip PENDING, recipient = the rewards account (not the author)
    const tip = await prisma.observedTip.findFirst({
      where: { paymentId: result.paymentId },
      include: { recipientAccount: true }
    })
    expect(tip.state).toBe('PENDING')
    expect(tip.recipientAccountId).toBe(rewards.id)
    expect(tip.recipientAccount.label).toBe('platform_rewards')
  })

  test('rejects when the author has no wallet AND the rewards wallet is not registered', async () => {
    const authorId = await createUser()
    const post = await createPost(authorId)
    const tipperId = await createUser()

    // The rewards-wallet fallback lookup is scoped to networkForEnv(), so resolve
    // it against MAINNET: no dev DB holds a MAINNET platform_rewards row (and the
    // stagenet one seeded by `sndev monero register-rewards-wallet` is ignored),
    // making the reject path deterministic in any environment. No account/webhook
    // is created before the lookup rejects, so the toggle is side-effect free.
    // (fail-closed REWARDS_PID_KEY mainnet guard in generateTipPaymentId is never
    // reached — the lookup rejects before any payment ID is minted.)
    process.env.MONERO_NETWORK = 'mainnet'
    try {
      await expect(resolvers.Mutation.initiateTip(null, {
        postId: String(post.id),
        amount: '1000000000'
      }, { me: { id: tipperId }, models: prisma, monero: makeMockLws() })).rejects.toThrow(/rewards wallet not registered/i)
    } finally {
      process.env.MONERO_NETWORK = 'stagenet'
    }
  })

  test('rejects an amount below PlatformFeeConfig.minTipPiconeros', async () => {
    // minTipPiconeros = 100_000_000 (0.0001 XMR). The floor is enforced before any
    // webhook is registered or ObservedTip created, so a sub-min tip is rejected
    // without lws side effects.
    const authorId = await createUser()
    await registerFor(authorId)
    const post = await createPost(authorId)
    const tipperId = await createUser()
    const lws = makeMockLws()

    await expect(resolvers.Mutation.initiateTip(null, {
      postId: String(post.id),
      amount: '99999999' // 1 piconero below the floor
    }, { me: { id: tipperId }, models: prisma, monero: lws })).rejects.toThrow(/min tip/i)
    expect(lws.addWebhook).not.toHaveBeenCalled()
  })

  test('emits tx_amount as DECIMAL XMR, not raw piconeros (Cake Wallet compatibility)', async () => {
    // Regression: initiateTip used to build the URI with BigInt(amount).toString(),
    // emitting raw piconeros as tx_amount. Cake/Monerujo parse tx_amount as decimal
    // XMR, so a 1e8-piconero (0.0001 XMR) tip was misread as 1e8 XMR. Pin the fix.
    const authorId = await createUser()
    await registerFor(authorId)
    const post = await createPost(authorId)
    const tipperId = await createUser()

    const result = await resolvers.Mutation.initiateTip(null, {
      postId: String(post.id),
      amount: '100000000' // 1e8 piconeros == 0.0001 XMR (the min tip)
    }, { me: { id: tipperId }, models: prisma, monero: makeMockLws() })

    expect(result.uri).toContain('tx_amount=0.0001')
    expect(result.uri).not.toMatch(/tx_amount=100000000/)
  })
})

describe('Query.myMoneroAccount', () => {
  test('returns me\'s account', async () => {
    const userId = await createUser()
    const { acct: created } = await registerFor(userId)

    const found = await resolvers.Query.myMoneroAccount(null, {}, { me: { id: userId }, models: prisma })
    expect(found.id).toBe(created.id)
    expect(found.user.privacyMode).toBe('AUTO_INDEX')
  })

  test('returns null when no me', async () => {
    expect(await resolvers.Query.myMoneroAccount(null, {}, { models: prisma })).toBeNull()
  })

  test('returns null when me has no account', async () => {
    const userId = await createUser()
    expect(await resolvers.Query.myMoneroAccount(null, {}, { me: { id: userId }, models: prisma })).toBeNull()
  })
})
