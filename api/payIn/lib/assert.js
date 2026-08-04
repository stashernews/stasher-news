const MAX_PENDING_PAY_INS_PER_USER = 100

// states that do not occupy a pending slot (terminal or withdrawn) — a payIn in
// any other state is still in flight and counts toward the pending cap
const NON_PENDING_STATES = [
  'PAID',
  'PENDING_WITHDRAWAL',
  'WITHDRAWAL_PAID',
  'WITHDRAWAL_FAILED',
  'FAILED',
  'CANCELLED',
  'FAILED_FORWARD'
]

// The old PayInBolt11 model was removed with the Lightning surface, so this guard
// counts outstanding PayIn rows directly instead of referencing the deleted model.
export async function assertBelowMaxPendingPayIns (models, payIn) {
  if (['PAID', 'PENDING_WITHDRAWAL'].includes(payIn.payInState)) {
    return
  }

  const pendingPayIns = await models.payIn.count({
    where: {
      userId: payIn.userId,
      payInState: { notIn: NON_PENDING_STATES }
    }
  })

  if (pendingPayIns >= MAX_PENDING_PAY_INS_PER_USER) {
    throw new Error('You have too many pending paid actions, cancel some or wait for them to expire')
  }
}

export function assertPiconerosRemaining (piconeros) {
  if (piconeros % 1000n !== 0n) {
    throw new Error('piconeros must be a multiple of 1000')
  }
}

export function assertBalancedPayInAndPayOuts (payIn) {
  // pay outs equal to piconeros
  // pay ins equal to piconeros if paid
  // pay ins less than piconeros if not paid
  const beneficiariesPiconeros = payIn.beneficiaries?.reduce((acc, beneficiary) => acc + beneficiary.piconeros, 0n) ?? 0n
  const payOutsMtokens = (payIn.payOutCustodialTokens?.reduce((acc, token) => acc + token.mtokens, 0n) ?? 0n) +
    beneficiariesPiconeros
  const payInsMtokens = payIn.payInCustodialTokens?.reduce((acc, token) => acc + token.mtokens, 0n) ?? 0n
  if (payOutsMtokens !== payIn.piconeros) {
    throw new Error(`pay outs must equal piconeros: ${payOutsMtokens} !== ${payIn.piconeros}`)
  }
  if (payIn.payInState === 'PAID' && payInsMtokens !== payIn.piconeros) {
    throw new Error(`pay ins must equal piconeros if paid: ${payInsMtokens} !== ${payIn.piconeros}`)
  }
  // PENDING_WITHDRAWAL is an exception - custodial tokens are debited immediately for withdrawals
  if (payIn.payInState === 'PENDING_WITHDRAWAL') {
    if (payInsMtokens !== payIn.piconeros) {
      throw new Error(`pay ins must equal piconeros if pending withdrawal: ${payInsMtokens} !== ${payIn.piconeros}`)
    }
  } else if (payIn.payInState !== 'PAID' && payInsMtokens >= payIn.piconeros) {
    throw new Error(`pay ins must be less than piconeros if not paid: ${payInsMtokens} >= ${payIn.piconeros}`)
  }

  payIn.beneficiaries?.forEach(beneficiary => {
    const payOutsPiconeros = beneficiary.payOutCustodialTokens.reduce((acc, token) => acc + token.mtokens, 0n)
    if (payOutsPiconeros !== beneficiary.piconeros) {
      throw new Error(`beneficiary pay outs must equal their piconeros: ${payOutsPiconeros} !== ${beneficiary.piconeros}`)
    }
  })
}
