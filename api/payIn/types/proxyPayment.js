export const anonable = false

// P2P payments removed - Monero integration pending
export const paymentMethods = []

export async function getInitial (models, { piconeros, description, descriptionHash, expiry }, { me }) {
  throw new Error('Monero payments not implemented')
}

export async function onBegin (tx, payInId, { comment, lud18Data, noteStr }) {
  throw new Error('Monero payments not implemented')
}

export async function onPaid (tx, payInId) {
  throw new Error('Monero payments not implemented')
}

export async function onPaidSideEffects (models, payInId) {
  throw new Error('Monero payments not implemented')
}

export async function describe (models, payInId) {
  throw new Error('Monero payments not implemented')
}
