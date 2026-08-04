/* eslint-env jest */
import { describe as describeZap } from '../../../api/payIn/types/zap'
import { describe as describeBoost } from '../../../api/payIn/types/boost'
import { describe as describeDonate } from '../../../api/payIn/types/donate'

const models = {
  payIn: {
    async findUnique ({ where, include }) {
      return {
        id: where.id,
        piconeros: 1_000_000n, // 0.000001 XMR ... actually 1e6 piconeros = 1e-6 XMR
        itemPayIn: { itemId: 42 }
      }
    }
  }
}

test('zap describe renders XMR and says tip, not sats/zap', async () => {
  const out = await describeZap(models, 1)
  expect(out).toMatch(/XMR/)
  expect(out).toMatch(/tip/)
  expect(out).not.toMatch(/sats|zap/i)
  expect(out).toMatch(/#42/)
})

test('boost describe renders XMR, no sats', async () => {
  const out = await describeBoost(models, 1)
  expect(out).toMatch(/XMR/)
  expect(out).not.toMatch(/sats/i)
  expect(out).toMatch(/#42/)
})

test('donate describe renders XMR, no sats', async () => {
  const out = await describeDonate(models, 1)
  expect(out).toMatch(/XMR/)
  expect(out).not.toMatch(/sats/i)
})
