/* eslint-env jest */
// Cache semantics for Item.turfPins using the REAL Item type policy from
// lib/apollo: a normalized Item is shared by every feed and the item page, so
// a mutation payload carrying the complete turfPins array must REPLACE the
// stored array (no stale removed turfs) and must not touch Item.position.
import { InMemoryCache, gql } from '@apollo/client'
import { itemFieldPolicies } from '@/lib/apollo'

const ITEMS_QUERY = gql`
  query ItemsAlpha($sub: String) {
    items(sub: $sub) {
      items { id position turfPins { subName position } }
      pins { id position turfPins { subName position } }
    }
  }`

const writeFeed = (cache, sub, item) =>
  cache.writeQuery({
    query: ITEMS_QUERY,
    variables: { sub },
    data: { items: { items: [item], pins: [] } }
  })

const itemAt = (cache, sub) =>
  cache.readQuery({ query: ITEMS_QUERY, variables: { sub } }).items.items[0]

const makeCache = () => new InMemoryCache({
  typePolicies: { Item: itemFieldPolicies },
  freezeResults: false
})

const sharedItem = {
  __typename: 'Item',
  id: 1,
  position: null,
  turfPins: [
    { __typename: 'TurfPin', subName: 'alpha', position: 1 },
    { __typename: 'TurfPin', subName: 'beta', position: 2 }
  ]
}

test('a mutation payload with the remaining pins replaces the stored array everywhere', () => {
  const cache = makeCache()
  writeFeed(cache, 'alpha', sharedItem)
  writeFeed(cache, 'beta', sharedItem)

  cache.writeFragment({
    id: 'Item:1',
    fragment: gql`
      fragment TurfPinResult on Item {
        id
        turfPins { subName position }
      }`,
    data: {
      __typename: 'Item',
      id: 1,
      turfPins: [{ __typename: 'TurfPin', subName: 'beta', position: 1 }]
    }
  })

  for (const sub of ['alpha', 'beta']) {
    const item = itemAt(cache, sub)
    expect(item.turfPins.map(pin => ({ subName: pin.subName, position: pin.position })))
      .toEqual([{ subName: 'beta', position: 1 }])
    // the legacy field is untouched by turf pin writes
    expect(item.position).toBeNull()
  }
})

test('a payload listing both pins keeps both in both feeds', () => {
  const cache = makeCache()
  writeFeed(cache, 'alpha', sharedItem)
  writeFeed(cache, 'beta', sharedItem)

  cache.writeFragment({
    id: 'Item:1',
    fragment: gql`
      fragment TurfPinResult2 on Item {
        id
        turfPins { subName position }
      }`,
    data: {
      __typename: 'Item',
      id: 1,
      turfPins: [
        { __typename: 'TurfPin', subName: 'alpha', position: 1 },
        { __typename: 'TurfPin', subName: 'beta', position: 1 }
      ]
    }
  })

  expect(itemAt(cache, 'alpha').turfPins.map(pin => pin.subName)).toEqual(['alpha', 'beta'])
  expect(itemAt(cache, 'beta').turfPins.map(pin => pin.subName)).toEqual(['alpha', 'beta'])
})
