/* eslint-env jest */
import { contributorSectionModel } from '@/lib/contributorPoolCopy'

const item = id => ({ id, title: `post ${id}` })

describe('contributorSectionModel', () => {
  test('OFF and missing data hide the section', () => {
    expect(contributorSectionModel(null)).toBeNull()
    expect(contributorSectionModel({ mode: 'OFF', candidates: [{ rank: 1, item: item(1) }] })).toBeNull()
  })

  test('SHADOW says nothing is paid and labels the last run as would-have-won', () => {
    const m = contributorSectionModel({
      mode: 'SHADOW',
      candidates: [{ rank: 1, item: item(1) }],
      lastRun: { mode: 'SHADOW', results: [{ rank: 1, piconeros: '9000000000', item: item(2) }] }
    })
    expect(m.shadow).toBe(true)
    expect(m.intro).toMatch(/shadow mode/)
    expect(m.intro).toMatch(/nothing is paid yet/)
    expect(m.resultsTitle).toMatch(/Would have won/)
    expect(m.candidates).toHaveLength(1)
  })

  test('ACTIVE after a shadow run still labels that run as shadow', () => {
    const m = contributorSectionModel({
      mode: 'ACTIVE',
      candidates: [],
      lastRun: { mode: 'SHADOW', results: [{ rank: 1, piconeros: '1', item: item(2) }] }
    })
    expect(m.shadow).toBe(false)
    expect(m.intro).toMatch(/share of the weekly rewards budget/)
    expect(m.intro).not.toMatch(/\d|%/)
    expect(m.resultsTitle).toMatch(/Would have won/)
  })

  test('an ACTIVE run lists winners and drops entries whose item is gone', () => {
    const m = contributorSectionModel({
      mode: 'ACTIVE',
      candidates: [{ rank: 1, item: null }, { rank: 2, item: item(5) }],
      lastRun: { mode: 'ACTIVE', results: [{ rank: 1, piconeros: '1', item: null }, { rank: 2, piconeros: '2', item: item(6) }] }
    })
    expect(m.resultsTitle).toBe('Last run’s winners')
    expect(m.candidates.map(c => c.rank)).toEqual([2])
    expect(m.results.map(r => r.rank)).toEqual([2])
  })
})
