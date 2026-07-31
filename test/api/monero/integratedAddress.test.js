/* eslint-env jest */
import { makeIntegratedAddress } from '@/api/monero/integratedAddress'

const STAGENET_PRIMARY = '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'
const PAYMENT_ID = '4f695d197f2a3c54'

test('makeIntegratedAddress returns an integrated address with the payment ID embedded', () => {
  const result = makeIntegratedAddress(STAGENET_PRIMARY, PAYMENT_ID)
  expect(result.integratedAddress).toMatch(/^5/) // stagenet integrated addresses start with 5
  expect(result.integratedAddress).toHaveLength(106) // integrated addresses are 106 chars
  expect(result.paymentId).toBe(PAYMENT_ID)
})

test('makeIntegratedAddress with empty payment ID generates a random 8-byte ID', () => {
  const result = makeIntegratedAddress(STAGENET_PRIMARY, '')
  expect(result.paymentId).toMatch(/^[0-9a-f]{16}$/)
  expect(result.integratedAddress).toHaveLength(106)
})

test('makeIntegratedAddress is deterministic for the same payment ID', () => {
  const a = makeIntegratedAddress(STAGENET_PRIMARY, PAYMENT_ID)
  const b = makeIntegratedAddress(STAGENET_PRIMARY, PAYMENT_ID)
  expect(a.integratedAddress).toBe(b.integratedAddress)
})

test('decoding the integrated address round-trips the payment ID', () => {
  const { integratedAddress } = makeIntegratedAddress(STAGENET_PRIMARY, PAYMENT_ID)
  // Decode the integrated address and confirm the payment ID bytes are present
  // at the expected offset (bytes 65-72, after network + spend + view keys).
  const { base58xmr } = require('@scure/base')
  const raw = base58xmr.decode(integratedAddress)
  const pidBytes = raw.slice(65, 73)
  expect(Buffer.from(pidBytes).toString('hex')).toBe(PAYMENT_ID)
})
