/* eslint-env jest */
import { settingsSchema, territorySchema, filterXmrValidator } from '@/lib/validate'

describe('settingsSchema piconero server bounds', () => {
  it('accepts the posting-fee default and 0 comments filter', async () => {
    await expect(settingsSchema.fields.postsPiconerosFilter.validate(1000000000)).resolves.toBe(1000000000)
    await expect(settingsSchema.fields.commentsPiconerosFilter.validate(0)).resolves.toBe(0)
  })
  it('rejects beyond ±0.01 XMR', async () => {
    await expect(settingsSchema.fields.postsPiconerosFilter.validate(10000000001)).rejects.toThrow(/at most 0.01 XMR/)
    await expect(settingsSchema.fields.commentsPiconerosFilter.validate(-10000000001)).rejects.toThrow(/at least -0.01 XMR/)
  })
})

describe('territorySchema piconero bounds', () => {
  const schema = territorySchema({})
  it('accepts the posting-fee default', async () => {
    await expect(schema.fields.postsPiconerosFilter.validate(1000000000)).resolves.toBe(1000000000)
  })
  it('rejects beyond ±0.01 XMR', async () => {
    await expect(schema.fields.postsPiconerosFilter.validate(10000000001)).rejects.toThrow(/at most 0.01 XMR/)
    await expect(schema.fields.postsPiconerosFilter.validate(-10000000001)).rejects.toThrow(/at least -0.01 XMR/)
  })
})

describe('filterXmrValidator client bounds', () => {
  it('accepts 0.001 and 0', async () => {
    await expect(filterXmrValidator.validate(0.001)).resolves.toBe(0.001)
    await expect(filterXmrValidator.validate(0)).resolves.toBe(0)
  })
  it('rejects beyond ±0.01 XMR', async () => {
    await expect(filterXmrValidator.validate(0.011)).rejects.toThrow(/at most 0.01 XMR/)
  })
})
