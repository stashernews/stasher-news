/* eslint-env jest */
import { NextRequest } from 'next/server'
import { proxy } from '@/proxy'

jest.mock('../../lib/auth', () => ({ secureCookie: name => name, cookieOptions: () => ({}) }))
jest.mock('../../lib/domains', () => ({
  getDomainMapping: async () => null,
  createDomainsDebugLogger: () => () => {}
}))
jest.mock('../../lib/invite-gate', () => ({ GATE_COOKIE: 'sn_gate', shouldGateRequest: async () => 'off' }))

test('/items/123/r/alice redirects to the item and attributes both referrers', async () => {
  const resp = await proxy(new NextRequest('https://stasher.news/items/123/r/alice'))
  expect(resp.status).toBe(307)
  expect(new URL(resp.headers.get('location')).pathname).toBe('/items/123')
  expect(resp.cookies.get('st_referrer')?.value).toBe('alice')
  expect(resp.cookies.get('st_referee_landing')?.value).toBe('item-123')
})

test('/r/bob redirects to the root and sets only the explicit referrer', async () => {
  const resp = await proxy(new NextRequest('https://stasher.news/r/bob'))
  expect(resp.status).toBe(307)
  expect(new URL(resp.headers.get('location')).pathname).toBe('/')
  expect(resp.cookies.get('st_referrer')?.value).toBe('bob')
  expect(resp.cookies.has('st_referee_landing')).toBe(false)
})

test('a content path without an /r/ segment passes through and attributes the content referrer', async () => {
  const resp = await proxy(new NextRequest('https://stasher.news/items/123'))
  expect(resp.headers.get('x-middleware-next')).toBe('1')
  expect(resp.cookies.get('st_referrer')?.value).toBe('item-123')
})
