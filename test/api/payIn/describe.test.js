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

test('donate describe reads the requested amount from the monero URI, not the 0n PayIn piconeros', async () => {
  // PESSIMISTIC DONATE payIns store piconeros=0n (the FeeObservation carries the
  // real on-chain amount). describe must render the amount the wallet was asked
  // to send, parsed from the stored moneroUri's tx_amount — never "0 XMR".
  const uriModels = {
    payIn: {
      async findUnique ({ where }) {
        return {
          id: where.id,
          piconeros: 0n,
          moneroUri: 'monero:53AmKkpCnLhwS7SfmGcbYPptv5DqJ7jZyGkgPnLgQqtA9pavY7dhMkqBfW5D6vjsLXjKzWko8qPEeqFBb3F2YqtG2ZJ8jVtM?tx_amount=3&tx_description=StasherNews%20donation'
        }
      }
    }
  }
  const out = await describeDonate(uriModels, 7)
  expect(out).toMatch(/donate 3 XMR/)
  expect(out).not.toMatch(/donate 0 XMR/)
})
