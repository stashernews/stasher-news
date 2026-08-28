/* eslint-env jest */
import { checkEmailSendAllowance, AUTH_EMAIL_IP_LIMIT, AUTH_EMAIL_IDENTIFIER_LIMIT } from '@/lib/auth-send-limiter'
import { __resetForTests } from '@/lib/rate-limit'

const hdr = (ip) => ({ 'x-forwarded-for': `spoof.example, ${ip}` })

beforeEach(() => __resetForTests())

test('allows the first send', () => {
  expect(checkEmailSendAllowance({ identifier: 'a@example.com', headers: hdr('10.0.0.1') })).toBeNull()
})

test('blocks the identifier cooldown silently after N sends to one address', () => {
  for (let i = 0; i < AUTH_EMAIL_IDENTIFIER_LIMIT; i++) {
    expect(checkEmailSendAllowance({ identifier: 'victim@example.com', headers: hdr(`10.2.0.${i}`) })).toBeNull()
  }
  expect(checkEmailSendAllowance({ identifier: 'victim@example.com', headers: hdr('10.2.9.9') })).toBe('identifier')
})

test('identifier matching is case/whitespace insensitive (plus-addressing still distinct)', () => {
  for (let i = 0; i < AUTH_EMAIL_IDENTIFIER_LIMIT; i++) {
    checkEmailSendAllowance({ identifier: 'victim@example.com', headers: hdr(`10.3.0.${i}`) })
  }
  expect(checkEmailSendAllowance({ identifier: '  VICTIM@example.com ', headers: hdr('10.3.9.9') })).toBe('identifier')
  expect(checkEmailSendAllowance({ identifier: 'victim+1@example.com', headers: hdr('10.3.9.10') })).toBeNull()
})

test('blocks the per-IP burst regardless of identifier rotation', () => {
  for (let i = 0; i < AUTH_EMAIL_IP_LIMIT; i++) {
    expect(checkEmailSendAllowance({ identifier: `u${i}@example.com`, headers: hdr('10.0.0.9') })).toBeNull()
  }
  expect(checkEmailSendAllowance({ identifier: 'another@example.com', headers: hdr('10.0.0.9') })).toBe('ip')
})
