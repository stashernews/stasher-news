import { MoneroUtils, MoneroNetworkType } from 'monero-ts'
import { encryptViewKey } from '../monero/viewkey'
import { makeIntegratedAddress } from '../monero/integratedAddress'
import { generateTipPaymentId } from '../monero/paymentId'
import { buildMoneroUri } from '../monero/uri'
import { isPrimaryAddress } from '../monero/primaryAddress'
import { classifyViewKey } from '../monero/viewKeyCheck'
import { LwsHttpError } from '../monero/lwsClient'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'
import { maybeGrantVerifiedBadge } from '@/api/verifiedBadge'
import { GqlAuthenticationError, GqlInputError } from '@/lib/error'
import { rateLimit } from '@/lib/rate-limit'
import { clientIp } from '@/lib/client-ip'

// StasherNews Monero wallet-setup + tip-initiation resolvers (spec §4.5, §7.3).
//
// Operations:
//   - Mutation.registerMoneroAccount — wallet onboarding (primary address + view key)
//   - Mutation.initiateTip           — start a P2P tip via webhook + payment ID
//   - Query.myMoneroAccount          — the caller's registered account
//
// `MoneroAccount` field resolver (controller #2): privacyMode lives on the
// owner USER (User.privacyMode) — not a column on the MoneroAccount model,
// so it is resolved per-field below.

// MONERO_NETWORK env ('stagenet' | 'mainnet' | 'testnet', default 'stagenet')
// maps to BOTH the monero-ts MoneroNetworkType enum (for validation) and the
// Prisma Network enum (for persistence). They must agree.
function networkForEnv () {
  const env = (process.env.MONERO_NETWORK || 'stagenet').toLowerCase()
  if (env === 'mainnet') return { moneroTs: MoneroNetworkType.MAINNET, prisma: 'MAINNET' }
  if (env === 'testnet') return { moneroTs: MoneroNetworkType.TESTNET, prisma: 'TESTNET' }
  return { moneroTs: MoneroNetworkType.STAGENET, prisma: 'STAGENET' }
}

// Core tip-initiation logic, extracted so it can be reused/tested independently of
// the GraphQL context. Enforces the min-tip floor, then: derives a payment ID,
// mints an integrated address from the recipient's primary address (the POST
// AUTHOR when they have a wallet, otherwise the platform rewards wallet — the
// wallet-less/anon author redirect lands in the pool), registers a lws
// tx-confirmation webhook, creates a PENDING ObservedTip, and returns the
// Cake-compatible monero: URI. The tipper sends to the integrated address; the
// webhook receiver (pages/api/monero/webhook.js) handles detection + confirmation
// and calls applyTipDetected (the ranking hook). 100% P2P — no PayIn, no platform
// output. `me` is the tipper (auth is the caller's responsibility).
export async function initiateTipCore ({ postId, amount, models, monero, me, headers }) {
  const id = Number(postId)
  const piconeros = BigInt(amount)

  const ipRl = rateLimit({ key: `tip:${clientIp(headers)}`, limit: 10, windowMs: 60_000 })
  if (!ipRl.allowed) throw new GqlInputError('too many tips initiated, try again shortly')

  const pending = await models.observedTip.count({
    where: { postId: id, state: 'PENDING' }
  })
  if (pending >= 20) throw new GqlInputError('too many pending tips on this post, try again later')

  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (!config) throw new GqlInputError('fee config not initialized')
  if (piconeros < config.minTipPiconeros) {
    throw new GqlInputError(`min tip is 0.0001 XMR (${config.minTipPiconeros} piconeros)`)
  }

  const post = await models.item.findUnique({ where: { id } })
  if (!post) throw new GqlInputError('post not found')
  // Self-tip gate: the client already hides the tip button on your own items;
  // this makes the server honest and skips a pointless webhook round-trip.
  // (Wallet-side self-sends by a logged-OUT author are caught at detection by
  // isSelfSend; unregistered-wallet self-tips are bounded by the rank caps.)
  if (me?.id != null && me.id === post.userId) {
    throw new GqlInputError('you cannot tip your own post')
  }

  // Resolve the recipient: the post author's wallet when registered, otherwise
  // the platform rewards wallet (the author has no wallet — e.g. an anonymous
  // post — so the tip lands in the pool instead of erroring). The payment-ID
  // namespace ("tip:" in api/monero/paymentId.js) is disjoint from downvotes
  // ("dv:"), so the rewardsWalletObserver can attribute it as TIP_UNWALLETED.
  let account = await models.moneroAccount.findFirst({ where: { ownerUserId: post.userId } })
  let recipient = 'AUTHOR'
  if (!account) {
    const net = networkForEnv().prisma
    // The schema constrains this to ONE platform_rewards row per network; when
    // duplicates somehow exist (test seeding), the first-registered row wins by
    // id so resolution is deterministic.
    account = await models.moneroAccount.findFirst({
      where: { label: 'platform_rewards', network: net },
      orderBy: { id: 'asc' }
    })
    if (!account) throw new GqlInputError('rewards wallet not registered')
    recipient = 'REWARDS'
  }

  const nonce = Date.now()
  const paymentId = generateTipPaymentId(id, nonce)
  const { integratedAddress } = makeIntegratedAddress(account.address, paymentId)

  const webhook = await monero.addWebhook({
    type: 'tx-confirmation',
    url: process.env.LWS_WEBHOOK_URL,
    address: account.address,
    paymentId,
    token: process.env.LWS_WEBHOOK_TOKEN || '',
    confirmations: REQUIRED_CONFIRMATIONS
  })

  await models.observedTip.create({
    data: {
      txHash: 'pending-' + paymentId,
      postId: id,
      tipperId: me?.id ?? null,
      recipientAccountId: account.id,
      recipientMajor: null,
      recipientMinor: null,
      paymentId,
      webhookEventId: webhook.event_id || null,
      piconeros,
      height: null,
      state: 'PENDING',
      proofType: 'INDEXED'
    }
  })

  // Cake Wallet / Monerujo parse tx_amount as DECIMAL XMR (not atomic units), so
  // the URI is built via buildMoneroUri + piconerosToXmrDecimal. Emitting raw
  // piconeros here would make every tip misread 1e12x by the receiving wallet.
  // No tx_payment_id param: the integrated address already embeds the payment id,
  // and Feather's wallet2 parse_uri rejects integrated-address URIs that also
  // carry tx_payment_id ("Separate payment id given with an integrated address").
  const uri = buildMoneroUri(
    [{ address: integratedAddress, amount: piconeros }],
    { description: `tip on "${post.title ?? ''}" via StasherNews` }
  )

  return { integratedAddress, paymentId, uri, recipient }
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
    },

    // Capability-style: no `me` gate. The paymentId (postId + nonce) is the
    // unguessable token the tip modal already holds, so polling survives a session
    // change. paymentId is NOT unique-constrained on ObservedTip, so findFirst.
    async tipStatus (parent, { paymentId }, { models }) {
      return models.observedTip.findFirst({
        where: { paymentId },
        select: { state: true, piconeros: true, confirmations: true }
      })
    },

    // Capability-style: no `me` gate. The paymentId (postId + nonce) is the
    // unguessable token the downvote modal already holds, so polling survives a
    // session change. paymentId is NOT unique-constrained on ObservedDownvote, so
    // findFirst. Returns null while the payment is not yet observed (waiting).
    async downvoteStatus (parent, { paymentId }, { models }) {
      return models.observedDownvote.findFirst({
        where: { paymentId },
        select: { state: true, piconeros: true, confirmations: true }
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
    // a client retry self-heals.
    async registerMoneroAccount (parent, { address, viewKey, privacyMode }, { me, models, monero }) {
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
      // lws add_account accepts PRIMARY addresses only: its parser rejects
      // subaddress and integrated variants with the same error::bad_address
      // as a wrong network (monero-lws src/db/string.cpp). monero-ts accepts
      // all three classes, so screen the network byte before calling lws.
      if (!isPrimaryAddress(address, net.prisma)) {
        throw new GqlInputError('integrated (payment id) and subaddress addresses are not accepted, use your wallet\'s primary address')
      }
      // Pair the view key with the address. monero-ts isValidPrivateViewKey is
      // FORMAT-ONLY — it accepts any 64-hex string, so a pasted PUBLIC view
      // key used to register "successfully" and the account silently never
      // detected a tip. classifyViewKey derives the public view key from the
      // candidate and compares it with the one embedded in the address.
      const vkClass = classifyViewKey(address, viewKey)
      if (vkClass === 'public') {
        throw new GqlInputError('that is your public view key - paste the private view key from your wallet\'s security/settings screen')
      }
      if (vkClass === 'mismatch') {
        throw new GqlInputError('this view key does not match that address - make sure the address and view key come from the same wallet')
      }
      if (vkClass !== 'ok') {
        throw new GqlInputError('invalid Monero private view key')
      }

      // 2. lws admin registration FIRST (plaintext view key over TLS — spec §5).
      //    addAccount is idempotent on address: re-registering a wallet that was
      //    previously unregistered (lws INACTIVE) reactivates it. A 500 escaping
      //    the client's idempotency fallback means lws rejected the address
      //    outright (it is absent from list_accounts) — a deterministic
      //    input-class failure, surfaced as a user-facing input error instead
      //    of an unexpected 500. Transient/infra errors (timeouts, 429, a 500
      //    from the fallback's list_accounts probe) still propagate as unexpected.
      try {
        await monero.addAccount(address, viewKey)
      } catch (err) {
        // Only an add_account 500 is a deterministic address rejection: the
        // client's idempotency fallback consumed the already-registered case,
        // so a 500 escaping here means lws refused THIS address. A 500 from
        // the fallback's list_accounts probe (or any other endpoint) is an
        // infra fault and stays unexpected.
        if (err instanceof LwsHttpError && err.status === 500 && err.url.includes('/add_account')) {
          throw new GqlInputError(`the indexer rejected this address, make sure it is your wallet's primary address for ${process.env.MONERO_NETWORK || 'stagenet'}`)
        }
        throw err
      }

      // 3. Persist locally in a transaction (atomic). encryptViewKey (Task 2)
      //    returns the spread-safe AES-256-GCM envelope; the plaintext is
      //    never written. Upsert on (address, network) so a wallet that was
      //    soft-deleted by unregisterMoneroAccount (ownerUserId -> null,
      //    status INACTIVE) can be re-registered by its owner.
      const created = await models.$transaction(async (tx) => {
        // Ownership guard: the upsert below keys on (address, network), so without
        // a check it would re-attach ANY matching row — a user holding a leaked view
        // key could steal the association of an ACTIVE wallet owned by someone else.
        // Inside the transaction for race safety with concurrent registrations.
        // Orphaned rows (ownerUserId null, soft-deleted) and the caller's own rows
        // fall through to the upsert, which re-attaches/updates them.
        const existing = await tx.moneroAccount.findFirst({
          where: { address, network: net.prisma }
        })
        if (existing && existing.ownerUserId !== null && existing.ownerUserId !== me.id) {
          throw new GqlInputError('address is registered to another account')
        }
        const account = await tx.moneroAccount.upsert({
          where: { address_network: { address, network: net.prisma } },
          create: {
            ownerUserId: me.id,
            address,
            label: 'author',
            network: net.prisma,
            status: 'ACTIVE',
            lwsRegisteredAt: new Date()
          },
          update: {
            ownerUserId: me.id,
            label: 'author',
            status: 'ACTIVE',
            lwsRegisteredAt: new Date()
          }
        })
        // Re-registration may carry a different view key: wipe any prior
        // envelope before writing the fresh one.
        await tx.moneroViewKey.deleteMany({ where: { accountId: account.id } })
        await tx.moneroViewKey.create({
          data: { accountId: account.id, ...encryptViewKey(viewKey) }
        })
        // privacyMode lives on the USER (controller #2), not MoneroAccount.
        // Default to AUTO_INDEX when the caller omits it — post-pivot there is
        // only one detection model, so AUTO_INDEX is the implicit choice.
        await tx.user.update({ where: { id: me.id }, data: { privacyMode: privacyMode ?? 'AUTO_INDEX' } })
        return account
      })

      // 4. Verified badge graduation: gated on wallet (just registered) AND the
      //    age+reputation gate. The badge itself is dynamic (hasWallet), so this
      //    only drives the one-time notification. Idempotent.
      try {
        await maybeGrantVerifiedBadge(models, me.id)
      } catch (err) {
        console.error('verified badge check failed:', err)
      }

      // 5. Return with the owner User eager-loaded so the privacyMode field
      //    resolver can read parent.user.privacyMode without an extra round
      //    trip.
      return models.moneroAccount.findUnique({
        where: { id: created.id },
        include: { user: true }
      })
    },

    // Spec §4.5. Start a P2P tip. Thin wrapper over initiateTipCore (which enforces
    // the min-tip floor, mints the integrated address + payment ID, registers the lws
    // webhook, and creates the PENDING ObservedTip). The webhook receiver handles
    // detection + confirmation and calls applyTipDetected (the ranking hook).
    // Anonymous tippers are allowed: initiateTipCore stores a null tipperId, which
    // the downstream pipeline already treats as "anonymous tip" (raw ranking only —
    // no curator shares, streaks, or trust-weighted votes).
    async initiateTip (parent, { postId, amount }, { me, models, monero, headers }) {
      return initiateTipCore({ postId, amount, models, monero, me, headers })
    },

    // Revoke wallet observation. Mirrors registerMoneroAccount's "lws FIRST"
    // ordering (controller #4): an lws failure aborts here so NOTHING local
    // changes — if we soft-deleted locally while lws kept scanning, the wallet
    // would keep receiving tip credits the owner believes they removed, which
    // is a privacy leak. deleteAddressWebhooks is best-effort (an INACTIVE lws
    // account stops firing webhooks anyway).
    async unregisterMoneroAccount (parent, args, { me, models, monero }) {
      if (!me) throw new GqlAuthenticationError()

      const account = await models.moneroAccount.findFirst({ where: { ownerUserId: me.id } })
      if (!account) return false

      await monero.modifyAccountStatus([account.address], 'inactive')
      try {
        await monero.deleteAddressWebhooks(account.address)
      } catch (err) {
        console.warn(`unregisterMoneroAccount: lws deleteAddressWebhooks failed (best-effort): ${err && err.message}`)
      }

      // Soft-delete: wipe the encrypted view key + subaddresses, then detach the
      // account from this user and mark it INACTIVE. The row is retained so
      // past ObservedTip history (FK RESTRICT, public ranking data) stays intact
      // and so registerMoneroAccount's upsert can re-attach the same wallet.
      await models.$transaction(async (tx) => {
        await tx.moneroViewKey.deleteMany({ where: { accountId: account.id } })
        await tx.subaddressIndex.deleteMany({ where: { accountId: account.id } })
        await tx.moneroAccount.update({
          where: { id: account.id },
          data: { ownerUserId: null, status: 'INACTIVE' }
        })
      })

      return true
    }
  },

  // Field resolver for the NON-model field on the GraphQL MoneroAccount
  // type (controller resolution #2). Cheap and only fires when the field is
  // actually selected.
  MoneroAccount: {
    // privacyMode lives on the owner User (User.privacyMode). Callers that
    // return a MoneroAccount MUST include the user relation for this to
    // resolve non-null — registerMoneroAccount / myMoneroAccount do.
    privacyMode: (parent) => parent.user?.privacyMode ?? null
  }
}
