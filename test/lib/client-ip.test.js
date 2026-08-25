/* eslint-env jest */
import { clientIp } from '@/lib/client-ip'

test('returns the rightmost XFF entry (the proxy-appended client IP)', () => {
  expect(clientIp({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })).toBe('5.6.7.8')
})

test('a spoofed client-supplied first entry cannot choose the key', () => {
  expect(clientIp({ 'x-forwarded-for': 'spoofed.example.com, 9.9.9.9' })).toBe('9.9.9.9')
})

test('single-entry XFF passes through', () => {
  expect(clientIp({ 'x-forwarded-for': ' 10.0.0.1 ' })).toBe('10.0.0.1')
})

test('empty/whitespace entries are skipped', () => {
  expect(clientIp({ 'x-forwarded-for': '1.2.3.4, , 5.6.7.8' })).toBe('5.6.7.8')
})

test('falls back to the socket address when no usable XFF', () => {
  expect(clientIp({}, '127.0.0.1')).toBe('127.0.0.1')
  expect(clientIp({ 'x-forwarded-for': '   ' }, '127.0.0.1')).toBe('127.0.0.1')
})

test('falls back to unknown when nothing is available', () => {
  expect(clientIp({})).toBe('unknown')
  expect(clientIp()).toBe('unknown')
})
