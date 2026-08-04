/* eslint-env jest */
import { getInitial, onBegin, onPaid } from '@/api/payIn/types/downZap'
import { GqlInputError } from '@/lib/error'

// Stagenet primary reused from integratedAddress.test.js so the generated
// integrated address shares its shape (106 chars, stagenet '5' prefix).
const STAGENET_PRIMARY = '5AWPhvfMuvWeePRNT192gwa9m63XHdzBmMxfizUhBJedJSqA1Y1BViTETV6uxyCS8Zf8Tz2KKEhHC8FjSRvuDgsd2JuAX6J'

const ORIG_ADDR = process.env.PLATFORM_REWARDS_ADDRESS
beforeEach(() => {
  process.env.PLATFORM_REWARDS_ADDRESS = STAGENET_PRIMARY
})
afterEach(() => {
  if (ORIG_ADDR === undefined) delete process.env.PLATFORM_REWARDS_ADDRESS
  else process.env.PLATFORM_REWARDS_ADDRESS = ORIG_ADDR
})

const ME = { id: 7 }
const POST_ID = 42
const CONFIG = {
  id: 1,
  downvoteMinPiconeros: 100000000n,
  defaultDownvotePiconeros: 1000000000n
}
const ITEM = { id: POST_ID, path: '42' }

function makeModels ({ item = ITEM, config = CONFIG } = {}) {
  const created = []
  const models = {
    platformFeeConfig: { findUnique: async () => config },
    item: { findUnique: async () => item },
    downvotePidMap: { create: async ({ data }) => { created.push(data); return data } }
  }
  models._created = created
  return models
}

describe('downZap.getInitial', () => {
  test('returns piconeros 0n and a monero: URI carrying a 106-char integrated address', async () => {
    const models = makeModels()
    const result = await getInitial(models, { id: POST_ID, piconeros: 1000000000n }, { me: ME })

    expect(result.payInType).toBe('DOWNVOTE')
    expect(result.piconeros).toBe(0n)
    expect(result.moneroUri).toMatch(/^monero:/)
    const addr = result.moneroUri.slice('monero:'.length).split('?')[0]
    expect(addr).toMatch(/^5/)
    expect(addr).toHaveLength(106)
    expect(result.moneroUri).toContain('tx_amount=')
  })

  test('records a DownvotePidMap row with postId, userId, and a future expiresAt', async () => {
    const models = makeModels()
    const before = Date.now()
    await getInitial(models, { id: POST_ID, piconeros: 1000000000n }, { me: ME })
    const after = Date.now()

    expect(models._created).toHaveLength(1)
    const row = models._created[0]
    expect(row.postId).toBe(POST_ID)
    expect(row.userId).toBe(ME.id)
    expect(row.paymentId).toMatch(/^[0-9a-f]{16}$/)
    expect(Number.isInteger(row.nonce)).toBe(true)
    expect(row.expiresAt.getTime()).toBeGreaterThan(before)
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000)
  })

  test('throws GqlInputError when piconeros is below downvoteMinPiconeros', async () => {
    const models = makeModels()
    await expect(
      getInitial(models, { id: POST_ID, piconeros: 99999999n }, { me: ME })
    ).rejects.toBeInstanceOf(GqlInputError)
  })

  test('throws GqlInputError when the item does not exist', async () => {
    const models = makeModels({ item: null })
    await expect(
      getInitial(models, { id: POST_ID, piconeros: 1000000000n }, { me: ME })
    ).rejects.toBeInstanceOf(GqlInputError)
  })

  test('throws GqlInputError when the fee config is missing', async () => {
    const models = makeModels({ config: null })
    await expect(
      getInitial(models, { id: POST_ID, piconeros: 1000000000n }, { me: ME })
    ).rejects.toBeInstanceOf(GqlInputError)
  })
})

describe('downZap.onBegin', () => {
  test('returns the DONT_LIKE_THIS act shape with no sats field', async () => {
    const tx = {
      $queryRaw: async () => [{ id: POST_ID, path: '42' }]
    }
    const result = await onBegin(tx, 1, { id: POST_ID, piconeros: 1000000000n })
    expect(result).toEqual({ id: POST_ID, path: '42', act: 'DONT_LIKE_THIS' })
    expect(result).not.toHaveProperty('sats')
  })
})

describe('downZap.onPaid', () => {
  test('is a no-op that applies no ranking side effects', async () => {
    const tx = { $executeRaw: jest.fn(), payIn: { findUnique: async () => ({ id: 1 }) } }
    await onPaid(tx, 1)
    expect(tx.$executeRaw).not.toHaveBeenCalled()
  })
})
