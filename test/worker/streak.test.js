/* eslint-env jest */
import { checkStreak } from '@/worker/streak'

// A tagged-template call passes (stringsArray, ...values) to the mock; the
// interpolated getStreakQuery result is a Prisma.sql object carrying the
// real query text and parameters. Flatten both into a { text, values }
// shape so assertions can inspect the nested union query.
async function captureStreakQuery () {
  let captured
  const models = {
    user: { findUnique: async () => ({ streak: null }) },
    $queryRaw: async (...args) => {
      const [strings, ...values] = args
      let text = ''
      const flatValues = []
      strings.forEach((chunk, i) => {
        text += chunk
        const value = values[i]
        if (value == null) return
        if (typeof value === 'object' && value.text !== undefined) {
          text += value.text
          flatValues.push(...(value.values || []))
        } else {
          flatValues.push(value)
        }
      })
      captured = { text, values: flatValues }
      return []
    }
  }
  await checkStreak({ data: { id: 5, type: 'COWBOY_HAT' }, models })
  return captured
}

test('counts P2P ObservedTip activity toward the streak (union branch)', async () => {
  const sql = await captureStreakQuery()
  expect(sql.text).toContain('ObservedTip')
  expect(sql.text).toContain('tipperId')
  expect(sql.values).toContain(5)
})

test('thresholds a streak day at 0.001 XMR (1e9 piconeros)', async () => {
  const sql = await captureStreakQuery()
  expect(sql.values).toContain(1000000000)
})

test('skips users with an active streak', async () => {
  const models = {
    user: { findUnique: async () => ({ streak: 3 }) },
    $queryRaw: jest.fn()
  }
  await checkStreak({ data: { id: 5, type: 'COWBOY_HAT' }, models })
  expect(models.$queryRaw).not.toHaveBeenCalled()
})
