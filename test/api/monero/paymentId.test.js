/* eslint-env jest */
import { generateTipPaymentId, generateDownvotePaymentId } from '@/api/monero/paymentId'

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

test('generateDownvotePaymentId returns a 16-char hex string', () => {
  const pid = generateDownvotePaymentId(42, 1)
  expect(pid).toMatch(/^[0-9a-f]{16}$/)
})

test('generateDownvotePaymentId is deterministic for the same (postId, nonce)', () => {
  const a = generateDownvotePaymentId(42, 1)
  const b = generateDownvotePaymentId(42, 1)
  expect(a).toBe(b)
})

test('generateDownvotePaymentId differs for different postId or nonce', () => {
  const a = generateDownvotePaymentId(42, 1)
  const b = generateDownvotePaymentId(42, 2)
  const c = generateDownvotePaymentId(43, 1)
  expect(a).not.toBe(b)
  expect(a).not.toBe(c)
})

test('generateDownvotePaymentId differs from generateTipPaymentId for the same (postId, nonce)', () => {
  const dv = generateDownvotePaymentId(42, 1)
  const tip = generateTipPaymentId(42, 1)
  expect(dv).not.toBe(tip)
})
