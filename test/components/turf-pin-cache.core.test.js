/* eslint-env jest */
import { InMemoryCache, gql } from '@apollo/client'
import { itemFieldPolicies } from '@/lib/apollo'

test('unpin replaces shared metadata without changing legacy position', () => {
  const cache = new InMemoryCache({ typePolicies: { Item: itemFieldPolicies } })
  const query = gql`query { item { id position turfPins { subName position } } }`
  cache.writeQuery({
    query,
    data: {
      item: {
        __typename: 'Item',
        id: 1,
        position: null,
        turfPins: [{ subName: 'a', position: 1 }, { subName: 'b', position: 2 }]
      }
    }
  })
  cache.writeFragment({
    id: 'Item:1',
    fragment: gql`fragment Pins on Item { turfPins { subName position } }`,
    data: { turfPins: [{ subName: 'b', position: 1 }] }
  })
  expect(cache.readQuery({ query }).item).toMatchObject({ position: null, turfPins: [{ subName: 'b', position: 1 }] })
})
