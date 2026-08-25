/* eslint-env jest */
import { assertItemCreateAllowance, ANON_ATTEMPTS_PER_HOUR, ATTEMPTS_PER_IP, MAX_PENDING_FEE_ITEMS } from '@/api/payIn/itemCreateAllowance'
import { __resetForTests } from '@/lib/rate-limit'
import { USER_ID } from '@/lib/constants'

const noItems = { item: { count: async () => 0 } }
const hdr = (ip) => ({ 'x-forwarded-for': `spoof.example, ${ip}` })

beforeEach(() => __resetForTests())

test('allows a fresh authenticated caller', async () => {
  await expect(assertItemCreateAllowance({ models: noItems, me: { id: 999 }, headers: hdr('10.0.0.1') })).resolves.toBeUndefined()
})

test('blocks the per-IP attempt burst', async () => {
  for (let i = 0; i < ATTEMPTS_PER_IP; i++) {
    await assertItemCreateAllowance({ models: noItems, me: { id: 999 }, headers: hdr('10.0.0.2') })
  }
  await expect(assertItemCreateAllowance({ models: noItems, me: { id: 999 }, headers: hdr('10.0.0.2') }))
    .rejects.toThrow('too many items created')
})

test('blocks a user at the pending-unpaid-fee-item cap', async () => {
  const models = { item: { count: async () => MAX_PENDING_FEE_ITEMS } }
  await expect(assertItemCreateAllowance({ models, me: { id: 999 }, headers: hdr('10.0.0.3') }))
    .rejects.toThrow('too many unpaid items')
})

test('anonymous callers get the hourly attempt limit instead of the pending cap', async () => {
  for (let i = 0; i < ANON_ATTEMPTS_PER_HOUR; i++) {
    await assertItemCreateAllowance({ models: noItems, me: null, headers: hdr('10.0.0.4') })
  }
  await expect(assertItemCreateAllowance({ models: noItems, me: null, headers: hdr('10.0.0.4') }))
    .rejects.toThrow('anonymous posting rate limit')
})

test('a session whose id IS the synthetic anon user hits the anon bucket, never the pending-count query', async () => {
  const neverQueried = { item: { count: async () => { throw new Error('must not query for anon') } } }
  // USER_ID.anon is the synthetic anon id from lib/constants.js (the payIn
  // engine's `me ??= { id: USER_ID.anon }`); the gate must route it to the
  // anonymous in-memory bucket
  await expect(assertItemCreateAllowance({ models: neverQueried, me: { id: USER_ID.anon }, headers: hdr('10.0.0.5') })).resolves.toBeUndefined()
  await expect(assertItemCreateAllowance({ models: neverQueried, me: { id: USER_ID.anon }, headers: hdr('10.0.0.6') })).resolves.toBeUndefined()
})

test('limits are env-overridable for operational tuning (audit follow-up #4)', () => {
  process.env.ITEM_CREATE_ATTEMPTS_PER_IP = '7'
  process.env.ITEM_CREATE_MAX_PENDING_FEE_ITEMS = '2'
  try {
    jest.resetModules()
    const mod = require(require.resolve('../../../api/payIn/itemCreateAllowance'))
    expect(mod.ATTEMPTS_PER_IP).toBe(7)
    expect(mod.MAX_PENDING_FEE_ITEMS).toBe(2)
  } finally {
    delete process.env.ITEM_CREATE_ATTEMPTS_PER_IP
    delete process.env.ITEM_CREATE_MAX_PENDING_FEE_ITEMS
  }
})
