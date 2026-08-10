import { PAID_ACTION_PAYMENT_METHODS } from '@/lib/constants'
import { reserveFeeSubaddress } from '@/api/monero/feePool'
import { buildMoneroUri } from '@/api/monero/uri'
import { piconerosToXmr, xmrToPiconeros } from '@/lib/format'
import { GqlInputError } from '@/lib/error'

// StasherNews boost (A-14) — upstream-faithful one-time permanent ranking
// weight, 1:1 with tips, paid to the platform rewards wallet via a DEDICATED
// major-5 fee subaddress (DONATE pattern, NOT the legacy custodial sats path).
//
// The payIn is born PAID (fee payIns resolve to PAID at creation with
// piconeros=0n — the FeeObservation carries the real on-chain amount): the
// client shows the monero: URI and polls `payIn(id).feeObserved`; the
// rewardsWalletObserver records the on-chain output as a
// FeeObservation('BOOST') at DETECTION and applies the ranking bump
// (Item.boost += actual on-chain amount) — the PESSIMISTIC-only restriction is
// deliberate: a custodial-funded boost would never produce an on-chain tx, so
// never create a FeeObservation, so never rank or fund the pool (silent
// no-op), exactly as DONATE documents.
//
// piconeros is 0n on the PayIn; the real amount is observed on-chain.

export const anonable = false

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.PESSIMISTIC
]

export async function getInitial (models, { id, piconeros }, { me }) {
  const config = await models.platformFeeConfig.findUnique({ where: { id: 1 } })
  if (!config) throw new GqlInputError('fee config not initialized')

  const amount = BigInt(piconeros)
  if (amount < config.minTipPiconeros) {
    throw new GqlInputError(`boost below minimum (${config.minTipPiconeros} piconeros)`)
  }

  const item = await models.item.findUnique({ where: { id: parseInt(id) } })
  if (!item) throw new GqlInputError('item not found')

  const sub = await reserveFeeSubaddress(models, 'BOOST')
  const moneroUri = buildMoneroUri(
    [{ address: sub.address, amount }],
    { description: 'StasherNews boost' }
  )

  return {
    payInType: 'BOOST',
    userId: me.id,
    piconeros: 0n,
    moneroUri,
    moneroSubaddressMajor: sub.major,
    moneroSubaddressMinor: sub.minor,
    itemPayIn: { itemId: parseInt(id) }
  }
}

export async function onRetry (tx, oldPayInId) {
  const { itemId, payIn } = await tx.itemPayIn.findUnique({ where: { payInId: oldPayInId }, include: { payIn: true } })
  return { id: itemId, piconeros: payIn.piconeros, act: 'BOOST' }
}

export async function onBegin (tx, payInId, { id }) {
  const item = await tx.item.findUnique({ where: { id: parseInt(id) } })
  return { id: item.id, path: item.path, piconeros: 0n, act: 'BOOST' }
}

// No-op: with the FeeObservation carrying the real amount, the ranking bump is
// applied by the rewardsWalletObserver at DETECTION (never before the money is
// on-chain).
export async function onPaid (tx, payInId) {
}

export async function describe (models, payInId) {
  const payIn = await models.payIn.findUnique({ where: { id: payInId } })
  const amount = amountPiconerosFromUri(payIn.moneroUri, 0n)
  return `SN: boost #${payIn.itemPayIn?.itemId ?? payIn.id} by ${piconerosToXmr(amount)}`
}

// Parse the requested piconeros out of a monero: URI's tx_amount (decimal XMR),
// falling back to the PayIn's own piconeros (0n) when the URI is absent.
// (Copied from donate.js — keep both in sync.)
function amountPiconerosFromUri (uri, fallback) {
  if (!uri) return fallback ?? 0n
  const q = uri.split('?')[1] || ''
  const xmr = new URLSearchParams(q).get('tx_amount')
  if (!xmr) return fallback ?? 0n
  try {
    return xmrToPiconeros(xmr)
  } catch {
    return fallback ?? 0n
  }
}
