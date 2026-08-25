import { PAID_ACTION_PAYMENT_METHODS } from '@/lib/constants'
import { reserveFeeSubaddress } from '@/api/monero/feePool'
import { buildMoneroUri } from '@/api/monero/uri'
import { piconerosToXmr, xmrToPiconeros } from '@/lib/format'

export const anonable = true

// PESSIMISTIC-only: the pool is funded via a FeeObservation, which only fires
// when the rewardsWalletObserver sees an on-chain output land on the DONATE
// fee subaddress. FEE_CREDIT / REWARD_SATS-funded donations would never produce
// an on-chain tx, so never create a FeeObservation, so never fund the pool —
// and with payIn piconeros = 0n they'd charge the user zero credits too (a
// silent no-op). The legacy `payOutCustodialTokens: REWARDS_POOL` booking (the
// old credit-path funding mechanism) is intentionally dropped; if a custodial
// donation path is wanted later it must be wired to write its own pool ledger
// entry directly, not rely on FeeObservation.
export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.PESSIMISTIC
]

export async function getInitial (models, { piconeros, rewardsPct }, { me }) {
  const sub = await reserveFeeSubaddress(models, 'DONATE', { me })
  const moneroUri = buildMoneroUri(
    [{ address: sub.address, amount: piconeros }],
    { description: 'StasherNews donation to the rewards pool' }
  )
  return {
    payInType: 'DONATE',
    userId: me?.id,
    piconeros: 0n,
    moneroUri,
    moneroSubaddressMajor: sub.major,
    moneroSubaddressMinor: sub.minor,
    donationRewardsPct: rewardsPct ?? null
  }
}

export async function describe (models, payInId) {
  const payIn = await models.payIn.findUnique({ where: { id: payInId } })
  // piconeros is 0n on the PayIn (the FeeObservation carries the real on-chain
  // amount, which doesn't exist yet for a PENDING payIn). Read the amount the
  // wallet was asked to send from the monero URI's tx_amount param instead.
  const amount = amountPiconerosFromUri(payIn.moneroUri, payIn.piconeros)
  return `SN: donate ${piconerosToXmr(amount)} to rewards pool`
}

// Parse the requested piconeros out of a monero: URI's tx_amount (decimal XMR),
// falling back to the PayIn's own piconeros (0n) when the URI is absent.
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
