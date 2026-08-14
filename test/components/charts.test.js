/* eslint-env jest */
import { transformData } from '@/components/charts'

jest.mock('recharts/lib/chart/LineChart', () => ({}))
jest.mock('recharts/lib/chart/AreaChart', () => ({}))
jest.mock('recharts/lib/chart/ComposedChart', () => ({}))
jest.mock('recharts/lib/chart/PieChart', () => ({}))
jest.mock('recharts/lib/cartesian/Line', () => ({}))
jest.mock('recharts/lib/cartesian/XAxis', () => ({}))
jest.mock('recharts/lib/cartesian/YAxis', () => ({}))
jest.mock('recharts/lib/cartesian/Area', () => ({}))
jest.mock('recharts/lib/cartesian/Bar', () => ({}))
jest.mock('recharts/lib/component/Tooltip', () => ({}))
jest.mock('recharts/lib/component/Legend', () => ({}))
jest.mock('recharts/lib/component/ResponsiveContainer', () => ({}))
jest.mock('recharts/lib/component/Cell', () => ({}))
jest.mock('recharts/lib/polar/Pie', () => ({}))

test('transformData unions series names across all buckets and zero-fills empty buckets', () => {
  const data = [
    { time: '2026-08-13T14:00:00.000Z', data: [] },
    { time: '2026-08-13T15:00:00.000Z', data: [{ name: 'DOWNVOTE', value: 3 }, { name: 'POSTING', value: 2 }] },
    { time: '2026-08-13T16:00:00.000Z', data: [{ name: 'TERRITORY', value: 1 }] }
  ]

  expect(transformData(data)).toEqual([
    { time: '2026-08-13T14:00:00.000Z', downvote: 0, posting: 0, territory: 0 },
    { time: '2026-08-13T15:00:00.000Z', downvote: 3, posting: 2, territory: 0 },
    { time: '2026-08-13T16:00:00.000Z', downvote: 0, posting: 0, territory: 1 }
  ])
})

test('transformData keeps every row carrying all series keys so data[0] exposes the union', () => {
  const data = [
    { time: 't0', data: [] },
    { time: 't1', data: [{ name: 'total', value: 5 }] }
  ]

  const rows = transformData(data)
  expect(Object.keys(rows[0])).toEqual(Object.keys(rows[1]))
  expect(rows[1].total).toBe(5)
})

test('transformData on all-empty input returns rows with only time', () => {
  const data = [{ time: 't0', data: [] }, { time: 't1', data: [] }]
  expect(transformData(data)).toEqual([{ time: 't0' }, { time: 't1' }])
})
