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

export function assertMcostRemaining (mcost) {
  if (mcost % 1000n !== 0n) {
    throw new Error('mcost must be a multiple of 1000')
  }
}

export function assertBalancedPayInAndPayOuts (payIn) {
  // pay outs equal to mcost
  // pay ins equal to mcost if paid
  // pay ins less than mcost if not paid
  const beneficiariesMcost = payIn.beneficiaries?.reduce((acc, beneficiary) => acc + beneficiary.mcost, 0n) ?? 0n
  const payOutsMtokens = (payIn.payOutCustodialTokens?.reduce((acc, token) => acc + token.mtokens, 0n) ?? 0n) +
    beneficiariesMcost
  const payInsMtokens = payIn.payInCustodialTokens?.reduce((acc, token) => acc + token.mtokens, 0n) ?? 0n
  if (payOutsMtokens !== payIn.mcost) {
    throw new Error(`pay outs must equal mcost: ${payOutsMtokens} !== ${payIn.mcost}`)
  }
  if (payIn.payInState === 'PAID' && payInsMtokens !== payIn.mcost) {
    throw new Error(`pay ins must equal mcost if paid: ${payInsMtokens} !== ${payIn.mcost}`)
  }
  // PENDING_WITHDRAWAL is an exception - custodial tokens are debited immediately for withdrawals
  if (payIn.payInState === 'PENDING_WITHDRAWAL') {
    if (payInsMtokens !== payIn.mcost) {
      throw new Error(`pay ins must equal mcost if pending withdrawal: ${payInsMtokens} !== ${payIn.mcost}`)
    }
  } else if (payIn.payInState !== 'PAID' && payInsMtokens >= payIn.mcost) {
    throw new Error(`pay ins must be less than mcost if not paid: ${payInsMtokens} >= ${payIn.mcost}`)
  }

  payIn.beneficiaries?.forEach(beneficiary => {
    const payOutsMcost = beneficiary.payOutCustodialTokens.reduce((acc, token) => acc + token.mtokens, 0n)
    if (payOutsMcost !== beneficiary.mcost) {
      throw new Error(`beneficiary pay outs must equal their mcost: ${payOutsMcost} !== ${beneficiary.mcost}`)
    }
  })
}
