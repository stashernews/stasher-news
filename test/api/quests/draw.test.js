/* eslint-env jest */
import { resolveDraw } from '@/api/quests/draw'
import { QUEST } from '@/lib/quests'

// jobs and bounties are transactional feeds, not community posting spots —
// they must never be drawn as quest targets.
test('the turf draw never picks jobs or bounties', async () => {
  const models = {
    sub: {
      findMany: async () => [
        { id: 1, name: 'jobs' },
        { id: 2, name: 'bounties' },
        { id: 3, name: 'bitcoin' },
        { id: 4, name: 'nostr' },
        { id: 5, name: 'monero' }
      ]
    }
  }
  let turfDraws = 0
  for (let userId = 1; userId <= 60; userId++) {
    for (const day of ['2026-09-24', '2026-09-25', '2026-10-01']) {
      const draw = await resolveDraw(models, userId, day)
      if (draw.drawn !== QUEST.TURF) continue
      turfDraws++
      expect(draw.turfName).toBeTruthy()
      expect(['jobs', 'bounties']).not.toContain(draw.turfName.toLowerCase())
    }
  }
  expect(turfDraws).toBeGreaterThan(20) // the sample really exercised the turf branch
})

test('the turf draw filters case-insensitively', async () => {
  const models = {
    sub: {
      findMany: async () => [
        { id: 1, name: 'Jobs' },
        { id: 2, name: 'BOUNTIES' },
        { id: 3, name: 'bitcoin' }
      ]
    }
  }
  for (let userId = 1; userId <= 30; userId++) {
    const draw = await resolveDraw(models, userId, '2026-09-24')
    if (draw.drawn !== QUEST.TURF) continue
    expect(['jobs', 'bounties']).not.toContain((draw.turfName || '').toLowerCase())
  }
})
