/* eslint-env jest */
import { collectDBBackedMetrics, register, __resetMetricsForTests } from '@/lib/metrics'

test('DB gauge exposition stays unchanged when overview shares its query readers', async () => {
  __resetMetricsForTests()
  await collectDBBackedMetrics({
    observedTip: { count: async () => 13 },
    $queryRaw: async () => [{ failed: 2 }],
    rewardDistribution: { findFirst: async () => ({ status: 'COMPLETE' }) }
  })
  expect(await register.metrics()).toMatchSnapshot()
})
