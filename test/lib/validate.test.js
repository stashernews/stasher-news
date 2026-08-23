/* eslint-env jest */
import { settingsSchema, territorySchema, filterXmrValidator, bountySchema } from '@/lib/validate'
import { BOUNTY_MIN_PICONEROS } from '@/lib/constants'

describe('settingsSchema piconero server bounds', () => {
  it('accepts the -0.1 XMR floor, the posting-fee default, and 0 comments filter', async () => {
    await expect(settingsSchema.fields.postsPiconerosFilter.validate(-100000000000)).resolves.toBe(-100000000000)
    await expect(settingsSchema.fields.postsPiconerosFilter.validate(1000000000)).resolves.toBe(1000000000)
    await expect(settingsSchema.fields.commentsPiconerosFilter.validate(0)).resolves.toBe(0)
  })
  it('rejects beyond -0.1..0.01 XMR', async () => {
    await expect(settingsSchema.fields.postsPiconerosFilter.validate(10000000001)).rejects.toThrow(/at most 0.01 XMR/)
    await expect(settingsSchema.fields.commentsPiconerosFilter.validate(-100000000001)).rejects.toThrow(/at least -0.1 XMR/)
  })
})

describe('territorySchema piconero bounds', () => {
  const schema = territorySchema({})
  it('accepts the -0.1 XMR turf default', async () => {
    await expect(schema.fields.postsPiconerosFilter.validate(-100000000000)).resolves.toBe(-100000000000)
    await expect(schema.fields.postsPiconerosFilter.validate(1000000000)).resolves.toBe(1000000000)
  })
  it('rejects beyond -0.1..0.01 XMR', async () => {
    await expect(schema.fields.postsPiconerosFilter.validate(10000000001)).rejects.toThrow(/at most 0.01 XMR/)
    await expect(schema.fields.postsPiconerosFilter.validate(-100000000001)).rejects.toThrow(/at least -0.1 XMR/)
  })
})

describe('filterXmrValidator client bounds', () => {
  it('accepts -0.1, 0.001 and 0', async () => {
    await expect(filterXmrValidator.validate(-0.1)).resolves.toBe(-0.1)
    await expect(filterXmrValidator.validate(0.001)).resolves.toBe(0.001)
    await expect(filterXmrValidator.validate(0)).resolves.toBe(0)
  })
  it('rejects beyond -0.1..0.01 XMR', async () => {
    await expect(filterXmrValidator.validate(0.011)).rejects.toThrow(/at most 0.01 XMR/)
    await expect(filterXmrValidator.validate(-0.11)).rejects.toThrow(/at least -0.1 XMR/)
  })
})

describe('bountySchema piconero validation (A-13)', () => {
  const schema = bountySchema({})
  const field = schema.fields.bountyPiconeros
  it('accepts the floor amount (BigInt limit compared without TypeError)', async () => {
    await expect(field.validate(Number(BOUNTY_MIN_PICONEROS))).resolves.toBe(Number(BOUNTY_MIN_PICONEROS))
  })
  it('rejects one piconero below the floor', async () => {
    await expect(field.validate(Number(BOUNTY_MIN_PICONEROS) - 1)).rejects.toThrow(/at least/)
  })
  it('rejects non-whole and non-number amounts', async () => {
    await expect(field.validate(1.5)).rejects.toThrow(/whole/)
    await expect(field.validate('nope')).rejects.toThrow(/number/)
  })
  it('rejects amounts beyond safe-integer range (lossy BigInt conversion)', async () => {
    await expect(field.validate(1e30)).rejects.toThrow(/safe integer/)
  })
  it('rejects a missing amount', async () => {
    await expect(field.validate(undefined)).rejects.toThrow(/required/)
  })
  it('whole schema accepts a complete bounty and rejects a missing amount', async () => {
    const withModels = bountySchema({
      models: {
        sub: {
          findMany: async () => [{
            name: 'monero', status: 'ACTIVE', postTypes: ['LINK', 'DISCUSSION', 'POLL', 'BOUNTY']
          }]
        }
      }
    })
    await expect(withModels.validate({
      title: 'test title',
      text: 'x',
      subNames: ['monero'],
      bountyPiconeros: Number(BOUNTY_MIN_PICONEROS)
    })).resolves.toEqual(expect.objectContaining({ bountyPiconeros: Number(BOUNTY_MIN_PICONEROS) }))
    await expect(withModels.validate({
      title: 'test title',
      text: 'x',
      subNames: ['monero']
    })).rejects.toThrow(/required/)
  })
})
