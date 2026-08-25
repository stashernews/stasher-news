/* eslint-env jest */

// Per-user attempt throttle at the fee-subaddress choke point (audit A-3
// follow-up). Every reserveFeeSubaddress consumer — item create/update, boost,
// donate, territory create/billing/unarchive/update — funnels through this one
// function, and every attempt permanently consumes one finite pool entry
// whether or not it is ever paid, so one per-user limit here covers all eight
// fee types. These tests use mock models: the throttle must fire BEFORE any DB
// work (the pool query itself is the resource being protected).

import { reserveFeeSubaddress, FEE_RESERVE_ATTEMPTS_PER_USER } from '@/api/monero/feePool'
import { USER_ID } from '@/lib/constants'
import { __resetForTests } from '@/lib/rate-limit'

const mockModels = () => ({
  moneroAccount: {
    findFirst: async () => ({ id: 4242 })
  },
  $queryRaw: async () => [{ id: 1, majorIndex: 1, minorIndex: 1, address: 'pool-addr' }]
})

beforeEach(() => __resetForTests())

test('allows reservations up to the per-user limit, then blocks', async () => {
  const models = mockModels()
  for (let i = 0; i < FEE_RESERVE_ATTEMPTS_PER_USER; i++) {
    await expect(reserveFeeSubaddress(models, 'POSTING', { me: { id: 999 } })).resolves.toHaveProperty('address', 'pool-addr')
  }
  await expect(reserveFeeSubaddress(models, 'POSTING', { me: { id: 999 } }))
    .rejects.toThrow('too many fee reservations')
})

test('the throttle fires before any DB work', async () => {
  const models = mockModels()
  for (let i = 0; i < FEE_RESERVE_ATTEMPTS_PER_USER; i++) {
    await reserveFeeSubaddress(models, 'BOOST', { me: { id: 999 } })
  }
  const mustNotQuery = async () => { throw new Error('must not query') }
  models.moneroAccount.findFirst = mustNotQuery
  models.$queryRaw = mustNotQuery
  await expect(reserveFeeSubaddress(models, 'BOOST', { me: { id: 999 } }))
    .rejects.toThrow('too many fee reservations')
})

test('tracks users independently and routes absent me to the anon bucket', async () => {
  const models = mockModels()
  for (let i = 0; i < FEE_RESERVE_ATTEMPTS_PER_USER; i++) {
    await reserveFeeSubaddress(models, 'POSTING', { me: { id: USER_ID.anon } })
  }
  // no `me` (direct/test callers) shares the synthetic anon bucket
  await expect(reserveFeeSubaddress(models, 'POSTING')).rejects.toThrow('too many fee reservations')
  // a different user is unaffected
  await expect(reserveFeeSubaddress(models, 'POSTING', { me: { id: 888 } })).resolves.toHaveProperty('address', 'pool-addr')
})
