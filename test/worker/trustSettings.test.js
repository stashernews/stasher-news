/* eslint-env jest */
import { trustGivenGraph, getGraph } from '@/worker/trust'
import { TRUST_DEFAULTS } from '@/lib/trust-defaults'

test('a changed seed restart weight changes the fixture walk', () => {
  const timer = jest.spyOn(console, 'timeLog').mockImplementation(() => {})
  try {
    const graph = [
      { id: 1, hops: [{ node: 2, trust: 0.5 }, { node: 3, trust: 0.3 }, { node: 4, trust: 0.2 }] },
      { id: 2, hops: [{ node: 3, trust: 1 }] },
      { id: 3, hops: [{ node: 4, trust: 1 }] },
      { id: 4, hops: [{ node: 4, trust: 1 }] }
    ]
    const baseline = trustGivenGraph(graph, [1], TRUST_DEFAULTS).toArray()
    const changed = trustGivenGraph(graph, [1], { ...TRUST_DEFAULTS, trustSeedWeight: 1 }).toArray()
    expect(baseline.slice(1).some(value => value > 0)).toBe(true)
    expect(changed.slice(1)).toEqual([0, 0, 0])
  } finally { timer.mockRestore() }
})

test('graph thresholds stay bound when changed', async () => {
  let query
  await getGraph({ $queryRaw: async (strings, ...values) => { query = { sql: strings.join('?'), values }; return [] } }, 'monero', true, [1], {
    ...TRUST_DEFAULTS, trustPicoMin: 1234567, trustAgainstPicoMin: 9876543
  })
  expect(query.sql).not.toContain('1234567')
  expect(query.sql).not.toContain('9876543')
  // Nested Prisma.sql fragments contain turf parameters, but these thresholds
  // are direct numeric bindings on the outer query.
  expect(query.values).toContain(1234567)
  expect(query.values).toContain(9876543)
})
