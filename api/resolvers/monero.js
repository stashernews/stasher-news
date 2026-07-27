import { MoneroUtils, MoneroNetworkType } from 'monero-ts'
import { encryptViewKey } from '../monero/viewkey'
import { GqlAuthenticationError, GqlAuthorizationError, GqlInputError } from '@/lib/error'

// StealthNews Monero wallet-setup resolvers (spec §7.3, controller res. #1-#7).
//
// Three operations only (YAGNI):
//   - Mutation.registerMoneroAccount — wallet onboarding
//   - Mutation.addSubaddresses       — grow an existing account's pool
//   - Query.myMoneroAccount          — the caller's registered account
//
// `MoneroAccount` field resolvers (controller #2): privacyMode lives on the
// owner USER (User.privacyMode), and subaddressPoolRemaining is the count of
// SubaddressIndex rows in state AVAILABLE — neither is a column on the
// MoneroAccount model, so they are resolved per-field below.

// MONERO_NETWORK env ('stagenet' | 'mainnet' | 'testnet', default 'stagenet')
// maps to BOTH the monero-ts MoneroNetworkType enum (for validation) and the
// Prisma Network enum (for persistence). They must agree.
function networkForEnv () {
  const env = (process.env.MONERO_NETWORK || 'stagenet').toLowerCase()
  if (env === 'mainnet') return { moneroTs: MoneroNetworkType.MAINNET, prisma: 'MAINNET' }
  if (env === 'testnet') return { moneroTs: MoneroNetworkType.TESTNET, prisma: 'TESTNET' }
  return { moneroTs: MoneroNetworkType.STAGENET, prisma: 'STAGENET' }
}

// Convert [SubaddressInput] into monero-lws's explicit-index range shape
// (spec §5.1 line 685): { "<majorIndex>": [[<minMinor>, <maxMinor>], ...], ... }
// where each [a,b] is an inclusive range. We collapse all supplied minors
// under a major into a single [min,max] range — sufficient for v1; lws accepts
// multiple disjoint ranges per major if a future caller needs them.
function subaddrsToRanges (subaddresses) {
  if (!subaddresses || subaddresses.length === 0) return null
  const byMajor = new Map()
  for (const s of subaddresses) {
    if (!byMajor.has(s.majorIndex)) byMajor.set(s.majorIndex, [])
    byMajor.get(s.majorIndex).push(s.minorIndex)
  }
  const ranges = {}
  for (const [major, minors] of byMajor.entries()) {
    const sorted = [...new Set(minors)].sort((a, b) => a - b)
    ranges[String(major)] = [[sorted[0], sorted[sorted.length - 1]]]
  }
  return ranges
}

export default {
  Query: {
    // §7.3 line 970. Returns the caller's MoneroAccount (with owner User
    // eager-loaded so the privacyMode field resolver resolves) or null.
    // Null-on-anonymous matches the codebase convention for `my*` queries.
    async myMoneroAccount (parent, args, { me, models }) {
      if (!me) return null
      return models.moneroAccount.findFirst({
        where: { ownerUserId: me.id },
        include: { user: true }
      })
    }
  },

  Mutation: {
    // §7.3 line 956. Wallet onboarding.
    //
    // Atomicity / lws-vs-local ordering (controller #4): lws.addAccount is
    // called FIRST so an lws failure leaves nothing locally. A local-persist
    // failure AFTER a successful lws addAccount leaves an lws-only orphan —
    // acceptable for v1 because lws add_account is idempotent on address, so
    // a client retry self-heals. (The reverse direction — local-first — would
    // leave an orphan MoneroAccount locally that lws doesn't know about AND
    // block retries via the @@unique([address, network]) constraint; harder
    // to recover. lws-first is the safer direction.)
    //
    // upsertSubaddrs is called AFTER local persist because lwsClient.
    // upsertSubaddrs(account, ranges) decrypts the account's view key from
    // its stored envelope (walletLogin -> viewKeyFor -> decryptViewKey), so
    // the MoneroViewKey row must exist first.
    async registerMoneroAccount (parent, { address, viewKey, privacyMode, subaddresses }, { me, models, monero }) {
      if (!me) throw new GqlAuthenticationError()
      const net = networkForEnv()

      // 1. Validate address + private view key via monero-ts (WASM-backed,
      //    async). Returns false on invalid input — surface a user-facing
      //    GQL error. This is the one place we hold the plaintext view key
      //    in-process before encrypting it; it never touches the DB, logs,
      //    or error messages.
      const addrOk = await MoneroUtils.isValidAddress(address, net.moneroTs)
      if (!addrOk) {
        throw new GqlInputError(`invalid Monero address for ${process.env.MONERO_NETWORK || 'stagenet'}`)
      }
      const vkOk = await MoneroUtils.isValidPrivateViewKey(viewKey)
      if (!vkOk) throw new GqlInputError('invalid Monero private view key')

      // 2. lws admin registration FIRST (plaintext view key over TLS — spec §5).
      await monero.addAccount(address, viewKey)

      // 3. Persist locally in a transaction (atomic). encryptViewKey (Task 2)
      //    returns the spread-safe AES-256-GCM envelope; the plaintext is
      //    never written. SubaddressIndex rows are seeded AVAILABLE.
      const created = await models.$transaction(async (tx) => {
        const account = await tx.moneroAccount.create({
          data: {
            ownerUserId: me.id,
            address,
            label: 'author',
            network: net.prisma,
            status: 'ACTIVE',
            lwsRegisteredAt: new Date()
          }
        })
        await tx.moneroViewKey.create({
          data: { accountId: account.id, ...encryptViewKey(viewKey) }
        })
        if (subaddresses && subaddresses.length > 0) {
          await tx.subaddressIndex.createMany({
            data: subaddresses.map(s => ({
              accountId: account.id,
              majorIndex: s.majorIndex,
              minorIndex: s.minorIndex,
              address: s.address,
              state: 'AVAILABLE'
            }))
          })
        }
        // privacyMode lives on the USER (controller #2), not MoneroAccount.
        await tx.user.update({ where: { id: me.id }, data: { privacyMode } })
        return account
      })

      // 4. Register the subaddress pool with lws (best-effort AFTER commit:
      //    lwsClient decrypts the view key from the stored envelope, so the
      //    MoneroViewKey row must exist first). On a transient lws failure
      //    here the local account is intact and the pool can be registered
      //    via addSubaddresses — the local DB is the source of truth.
      if (subaddresses && subaddresses.length > 0) {
        const fresh = await models.moneroAccount.findUnique({
          where: { id: created.id },
          include: { viewKey: true }
        })
        await monero.upsertSubaddrs(fresh, subaddrsToRanges(subaddresses))
      }

      // 5. Return with the owner User eager-loaded so the privacyMode field
      //    resolver can read parent.user.privacyMode without an extra round
      //    trip. subaddressPoolRemaining resolves via its own field resolver.
      return models.moneroAccount.findUnique({
        where: { id: created.id },
        include: { user: true }
      })
    },

    // §7.3 line 958. Grow an existing account's subaddress pool. The caller
    // must own the account.
    async addSubaddresses (parent, { accountId, subaddresses }, { me, models, monero }) {
      if (!me) throw new GqlAuthenticationError()
      const id = Number(accountId)
      if (!Number.isInteger(id) || id <= 0) throw new GqlInputError('invalid accountId')
      const account = await models.moneroAccount.findUnique({
        where: { id },
        include: { viewKey: true }
      })
      if (!account) throw new GqlInputError('account not found')
      if (account.ownerUserId !== me.id) throw new GqlAuthorizationError('not your account')

      // Empty-list short-circuit: subaddrsToRanges([]) -> null, and
      // lwsClient.upsertSubaddrs(account, null) defaults to { 0: [[0, 499]] }
      // (api/monero/lwsClient.js), silently registering 500 default
      // subaddresses. Mirrors registerMoneroAccount's empty-list guard.
      if (!subaddresses || subaddresses.length === 0) {
        return models.moneroAccount.findUnique({
          where: { id },
          include: { user: true }
        })
      }

      // Local persist first (idempotent on (accountId, majorIndex, minorIndex)
      // via @@unique), then lws registration. createMany skips duplicates so a
      // retry after a partial lws failure won't double-insert.
      await models.subaddressIndex.createMany({
        data: subaddresses.map(s => ({
          accountId: id,
          majorIndex: s.majorIndex,
          minorIndex: s.minorIndex,
          address: s.address,
          state: 'AVAILABLE'
        })),
        skipDuplicates: true
      })
      await monero.upsertSubaddrs(account, subaddrsToRanges(subaddresses))
      return models.moneroAccount.findUnique({
        where: { id },
        include: { user: true }
      })
    }
  },

  // Field resolvers for the two NON-model fields on the GraphQL MoneroAccount
  // type (controller resolution #2). Both are cheap and only fire when the
  // field is actually selected.
  MoneroAccount: {
    // privacyMode lives on the owner User (User.privacyMode). Callers that
    // return a MoneroAccount MUST include the user relation for this to
    // resolve non-null — registerMoneroAccount / myMoneroAccount do.
    privacyMode: (parent) => parent.user?.privacyMode ?? null,

    // subaddressPoolRemaining: count of AVAILABLE SubaddressIndex rows.
    subaddressPoolRemaining: (parent, args, { models }) =>
      models.subaddressIndex.count({ where: { accountId: parent.id, state: 'AVAILABLE' } })
  }
}
