/* eslint-env jest */
import { generateTipPaymentId } from '@/api/monero/paymentId'

test('generateTipPaymentId returns a 16-char hex string', () => {
  const pid = generateTipPaymentId(42, 1)
  expect(pid).toMatch(/^[0-9a-f]{16}$/)
})

test('generateTipPaymentId is deterministic for the same (postId, nonce)', () => {
  const a = generateTipPaymentId(42, 1)
  const b = generateTipPaymentId(42, 1)
  expect(a).toBe(b)
})

test('generateTipPaymentId differs for different postId or nonce', () => {
  const a = generateTipPaymentId(42, 1)
  const b = generateTipPaymentId(42, 2)
  const c = generateTipPaymentId(43, 1)
  expect(a).not.toBe(b)
  expect(a).not.toBe(c)
})
