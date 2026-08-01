import { MoneroUtils, MoneroNetworkType } from 'monero-ts'
import { encryptViewKey } from '../monero/viewkey'
import { makeIntegratedAddress } from '../monero/integratedAddress'
import { generateTipPaymentId } from '../monero/paymentId'
import { buildMoneroUri } from '../monero/uri'
import { REQUIRED_CONFIRMATIONS } from '@/lib/constants'
import { GqlAuthenticationError, GqlInputError } from '@/lib/error'

// StealthNews Monero wallet-setup + tip-initiation resolvers (spec §4.5, §7.3).
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
// mints an integrated address from the POST AUTHOR's primary address, registers a
// lws tx-confirmation webhook, creates a PENDING ObservedTip, and returns the
// Cake-compatible monero: URI. The tipper sends to the integrated address; the
// webhook receiver (pages/api/monero/webhook.js) handles detection + confirmation
// and calls applyTipDetected (the ranking hook). 100% P2P — no PayIn, no platform
// output. `me` is the tipper (auth is the caller's responsibility).
export async function initiateTipCore ({ postId, amount, models, monero }) {
  const id = Number(postId)
  const piconeros = BigInt(amount)

  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (!config) throw new GqlInputError('fee config not initialized')
  if (piconeros < config.minTipPiconeros) {
    throw new GqlInputError(`min tip is 0.0001 XMR (${config.minTipPiconeros} piconeros)`)
  }

  const post = await models.item.findUnique({ where: { id } })
  if (!post) throw new GqlInputError('post not found')

  // The recipient is the post author — their MoneroAccount holds the primary
  // address the integrated address is derived from.
  const account = await models.moneroAccount.findFirst({ where: { ownerUserId: post.userId } })
  if (!account) throw new GqlInputError('post author has no monero account')

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
      tipperId: null,
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
  const uri = buildMoneroUri(
    [{ address: integratedAddress, amount: piconeros }],
    { description: `tip on "${post.title ?? ''}" via StealthNews`, paymentId }
  )

  return { integratedAddress, paymentId, uri }
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
      const vkOk = await MoneroUtils.isValidPrivateViewKey(viewKey)
      if (!vkOk) throw new GqlInputError('invalid Monero private view key')

      // 2. lws admin registration FIRST (plaintext view key over TLS — spec §5).
      await monero.addAccount(address, viewKey)

      // 3. Persist locally in a transaction (atomic). encryptViewKey (Task 2)
      //    returns the spread-safe AES-256-GCM envelope; the plaintext is
      //    never written.
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
        // privacyMode lives on the USER (controller #2), not MoneroAccount.
        // Default to AUTO_INDEX when the caller omits it — post-pivot there is
        // only one detection model, so AUTO_INDEX is the implicit choice.
        await tx.user.update({ where: { id: me.id }, data: { privacyMode: privacyMode ?? 'AUTO_INDEX' } })
        return account
      })

      // 4. Return with the owner User eager-loaded so the privacyMode field
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
    async initiateTip (parent, { postId, amount }, { me, models, monero }) {
      if (!me) throw new GqlAuthenticationError()
      return initiateTipCore({ postId, amount, models, monero })
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
