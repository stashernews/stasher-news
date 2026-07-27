/* eslint-env jest */

// Integration tests for the Monero wallet-setup resolvers (Task 8 / spec §7.3).
//
// registerMoneroAccount is the wallet-onboarding mutation: it validates the
// stagenet address + private view key via monero-ts (real validation, NOT
// mocked — the validation IS part of what's being tested per the brief),
// encrypts the view key (Task 2 envelope), registers the account + the
// subaddress pool with monero-lws, and persists MoneroAccount / MoneroViewKey
// / SubaddressIndex rows (Task 1 schema) + sets User.privacyMode.
//
// The lwsClient is the only mock — it is the network boundary (DI seam on the
// Apollo `monero` context). Everything else is real DB behaviour against a
// live, migrated database, mirroring test/worker/moneroIndexer.test.js.
//
// Run via the node:22.21.1 helper container:
//   docker exec sn-prisma npx jest test/api/resolvers/monero.test.js

import { PrismaClient } from '@prisma/client'
import resolvers from '@/api/resolvers/monero'

// Envelope encryption needs a master key in the env (Task 2). Set before any
// encryptViewKey call; getMasterKey() lazily caches it.
process.env.VIEWKEY_MASTER_KEY = Buffer.from('a'.repeat(32)).toString('base64')

const prisma = new PrismaClient()

// Real valid stagenet test vectors. Derived OFFLINE from monero-ts
// createWalletKeys({ networkType: STAGENET }) (see task-8-report.md):
//   - address validates via MoneroUtils.isValidAddress(addr, STAGENET) -> true
//   - view key validates via MoneroUtils.isValidPrivateViewKey(vk) -> true
// Hard-coded so the test fixture is stable across runs (no wallet-gen in CI).
const STAGENET_ADDR = '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'
const STAGENET_VIEWKEY = '5580e0440c77c9b720950defd0bcfbd87b6a10f098ed345fac290c7f48b3c60e'
// On a fresh wallet, subaddress (0,0) IS the primary address, so it is itself
// a valid stagenet address — sufficient for the SubaddressIndex row's stored
// `address` (the resolver does NOT verify parent-child, which would require
// the spend key).
const STAGENET_SUBADDR_0_0 = STAGENET_ADDR

// Mock lwsClient — the network boundary (DI via context.monero). The real
// addAccount / upsertSubaddrs are exercised end-to-end in test/api/monero/
// lwsClient.test.js (Task 3); here we only assert the resolver calls them
// with the right shape.
function makeMockLws () {
  return {
    addAccount: jest.fn().mockResolvedValue({}),
    upsertSubaddrs: jest.fn().mockResolvedValue({})
  }
}

// FK-safe teardown per test (so the same valid stagenet address can be reused
// across tests despite the @@unique([address, network]) constraint).
// Order: SubaddressIndex + MoneroViewKey -> MoneroAccount -> users.
const created = { users: [], accounts: [] }

async function cleanupTracked () {
  await prisma.subaddressIndex.deleteMany({ where: { accountId: { in: created.accounts } } })
  await prisma.moneroViewKey.deleteMany({ where: { accountId: { in: created.accounts } } })
  await prisma.moneroAccount.deleteMany({ where: { id: { in: created.accounts } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
  created.users.length = 0
  created.accounts.length = 0
}

afterEach(cleanupTracked)
afterAll(async () => {
  await cleanupTracked()
  await prisma.$disconnect()
})

async function createUser () {
  const rows = await prisma.$queryRaw`INSERT INTO users DEFAULT VALUES RETURNING id::int AS id`
  const id = rows[0].id
  created.users.push(id)
  return id
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

describe('Mutation.registerMoneroAccount', () => {
  test('validates, encrypts the view key, calls lws addAccount + upsertSubaddrs, creates SubaddressIndex AVAILABLE, sets User.privacyMode', async () => {
    const userId = await createUser()
    const { acct, lws } = await registerFor(userId, {
      subaddresses: [{ majorIndex: 0, minorIndex: 0, address: STAGENET_SUBADDR_0_0 }]
    })

    // MoneroAccount created with the supplied address.
    expect(acct.address).toBe(STAGENET_ADDR)
    expect(acct.label).toBe('author')
    expect(acct.network).toBe('STAGENET')

    // lws admin registration happened with the PLAINTEXT view key (the one
    // place plaintext traverses the wire, over TLS — spec §5).
    expect(lws.addAccount).toHaveBeenCalledWith(STAGENET_ADDR, STAGENET_VIEWKEY)
    expect(lws.addAccount).toHaveBeenCalledTimes(1)

    // lws subaddress pool registration happened with the account + the derived
    // explicit-index range shape (spec §5.1: { "<major>": [[minMinor, maxMinor]] }).
    expect(lws.upsertSubaddrs).toHaveBeenCalledTimes(1)
    const [acctArg, rangesArg] = lws.upsertSubaddrs.mock.calls[0]
    expect(acctArg.address).toBe(STAGENET_ADDR)
    expect(rangesArg).toEqual({ 0: [[0, 0]] })

    // MoneroViewKey persisted encrypted: ciphertext hex AND utf8 must NOT
    // contain the plaintext view key (defence-in-depth on top of GCM).
    const stored = await prisma.moneroViewKey.findUnique({ where: { accountId: acct.id } })
    expect(stored.ciphertext.toString('hex')).not.toContain(STAGENET_VIEWKEY)
    expect(stored.ciphertext.toString('utf8')).not.toContain(STAGENET_VIEWKEY)
    expect(stored.dekVersion).toBe(1)

    // SubaddressIndex row created AVAILABLE.
    const subs = await prisma.subaddressIndex.findMany({ where: { accountId: acct.id } })
    expect(subs).toHaveLength(1)
    expect(subs[0].state).toBe('AVAILABLE')
    expect(subs[0].majorIndex).toBe(0)
    expect(subs[0].minorIndex).toBe(0)
    expect(subs[0].address).toBe(STAGENET_SUBADDR_0_0)

    // User.privacyMode set (lives on USER, not MoneroAccount — controller #2).
    const user = await prisma.user.findUnique({ where: { id: userId } })
    expect(user.privacyMode).toBe('AUTO_INDEX')

    // Computed field resolvers (controller #2): privacyMode reads from the
    // eager-loaded owner User; subaddressPoolRemaining counts AVAILABLE rows.
    const ctxForFields = { models: prisma }
    expect(resolvers.MoneroAccount.privacyMode(acct)).toBe('AUTO_INDEX')
    expect(await resolvers.MoneroAccount.subaddressPoolRemaining(acct, null, ctxForFields)).toBe(1)
  })

  test('rejects an invalid address (monero-ts isValidAddress returns false) and persists nothing', async () => {
    const userId = await createUser()
    const lws = makeMockLws()
    await expect(resolvers.Mutation.registerMoneroAccount(null, {
      address: 'not-a-real-monero-address',
      viewKey: STAGENET_VIEWKEY,
      privacyMode: 'AUTO_INDEX'
    }, { me: { id: userId }, models: prisma, monero: lws })).rejects.toThrow(/invalid monero address/i)

    // lws.addAccount MUST NOT have run (validation gates registration).
    expect(lws.addAccount).not.toHaveBeenCalled()
    // Nothing was persisted locally.
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

  test('rejects if no me (GqlAuthenticationError: "you must be logged in")', async () => {
    await expect(resolvers.Mutation.registerMoneroAccount(null, {
      address: STAGENET_ADDR,
      viewKey: STAGENET_VIEWKEY,
      privacyMode: 'AUTO_INDEX'
    }, { models: prisma, monero: makeMockLws() })).rejects.toThrow(/you must be logged in/i)
  })

  test('without subaddresses: registers account + view key only, skips upsertSubaddrs', async () => {
    // Controller #4: "if privacyMode is MANUAL_PROOF, subaddresses may be
    // absent — handle both."
    const userId = await createUser()
    const { acct, lws } = await registerFor(userId, { privacyMode: 'MANUAL_PROOF' })

    expect(lws.addAccount).toHaveBeenCalledTimes(1)
    expect(lws.upsertSubaddrs).not.toHaveBeenCalled()
    expect(acct.address).toBe(STAGENET_ADDR)

    const user = await prisma.user.findUnique({ where: { id: userId } })
    expect(user.privacyMode).toBe('MANUAL_PROOF')
  })
})

describe('Mutation.addSubaddresses', () => {
  test('adds SubaddressIndex rows + calls upsertSubaddrs with derived ranges', async () => {
    const userId = await createUser()
    const { acct: seed } = await registerFor(userId)

    const lws = makeMockLws()
    const acct = await resolvers.Mutation.addSubaddresses(null, {
      accountId: String(seed.id),
      subaddresses: [
        { majorIndex: 0, minorIndex: 1, address: STAGENET_SUBADDR_0_0 },
        { majorIndex: 0, minorIndex: 2, address: STAGENET_SUBADDR_0_0 }
      ]
    }, { me: { id: userId }, models: prisma, monero: lws })

    expect(acct.id).toBe(seed.id)
    expect(lws.upsertSubaddrs).toHaveBeenCalledTimes(1)
    const [, rangesArg] = lws.upsertSubaddrs.mock.calls[0]
    expect(rangesArg).toEqual({ 0: [[1, 2]] })

    const subs = await prisma.subaddressIndex.findMany({ where: { accountId: seed.id } })
    expect(subs).toHaveLength(2)
    expect(subs.map(s => s.minorIndex).sort((a, b) => a - b)).toEqual([1, 2])
    expect(subs.every(s => s.state === 'AVAILABLE')).toBe(true)
  })

  test('rejects if me does not own the account (GqlAuthorizationError)', async () => {
    const ownerId = await createUser()
    const intruderId = await createUser()
    const { acct: seed } = await registerFor(ownerId)

    await expect(resolvers.Mutation.addSubaddresses(null, {
      accountId: String(seed.id),
      subaddresses: [{ majorIndex: 0, minorIndex: 1, address: STAGENET_SUBADDR_0_0 }]
    }, { me: { id: intruderId }, models: prisma, monero: makeMockLws() })).rejects.toThrow(/not your account/i)
  })

  test('rejects if no me', async () => {
    await expect(resolvers.Mutation.addSubaddresses(null, {
      accountId: '1',
      subaddresses: []
    }, { models: prisma, monero: makeMockLws() })).rejects.toThrow(/you must be logged in/i)
  })
})

describe('Query.myMoneroAccount', () => {
  test('returns me\'s account', async () => {
    const userId = await createUser()
    const { acct: created } = await registerFor(userId)

    const found = await resolvers.Query.myMoneroAccount(null, {}, { me: { id: userId }, models: prisma })
    expect(found.id).toBe(created.id)
    // owner User eager-loaded so the privacyMode field resolver can read it.
    expect(found.user.privacyMode).toBe('AUTO_INDEX')
  })

  test('returns null when no me (matches the my* null-on-anonymous convention)', async () => {
    expect(await resolvers.Query.myMoneroAccount(null, {}, { models: prisma })).toBeNull()
  })

  test('returns null when me has no account', async () => {
    const userId = await createUser()
    expect(await resolvers.Query.myMoneroAccount(null, {}, { me: { id: userId }, models: prisma })).toBeNull()
  })
})
