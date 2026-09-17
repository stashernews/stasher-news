/* eslint-env jest */
// ITEM_UPDATE args are persisted verbatim for deferred fee-bearing edits
// (PendingItemUpdate.args). They can contain BigInt values (GraphQL BigInt
// scalars, e.g. bountyPiconeros) that JSON/Prisma Json cannot serialise — the
// codec tags and revives them losslessly.
import { serializePayInArgs, deserializePayInArgs } from '@/api/payIn/lib/payInArgs'

test('round-trips BigInt values through the stored JSON shape', () => {
  const args = {
    id: '42',
    text: 'edited with media',
    uploadIds: [6, 7],
    bountyPiconeros: 12345678901234567890n,
    nested: { n: 2n, s: 'x' },
    list: [1n, 'two', null]
  }

  const stored = serializePayInArgs(args)
  expect(() => JSON.stringify(stored)).not.toThrow()
  expect(stored.bountyPiconeros).toEqual({ $bigint: '12345678901234567890' })

  expect(deserializePayInArgs(stored)).toEqual(args)
})

test('leaves BigInt-free args unchanged', () => {
  const args = { id: 1, text: 'plain', subNames: ['meta'] }
  expect(serializePayInArgs(args)).toEqual(args)
  expect(deserializePayInArgs(serializePayInArgs(args))).toEqual(args)
})
