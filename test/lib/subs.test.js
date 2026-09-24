/* eslint-env jest */
import { postFormType, defaultPostType, itemPostType } from '@/lib/subs'

describe('postFormType', () => {
  test('regular types pass through', () => {
    expect(postFormType('link', [{ name: 'bitcoin' }])).toBe('link')
    expect(postFormType('discussion', [])).toBe('discussion')
    expect(postFormType('poll', [{ name: 'bitcoin' }])).toBe('poll')
    expect(postFormType('bounty', [{ name: 'bitcoin' }])).toBe('bounty')
  })

  test('job types resolve only when the jobs turf is a target', () => {
    expect(postFormType('job', [{ name: 'jobs' }])).toBe('job')
    expect(postFormType('jobs', [{ name: 'jobs' }])).toBe('job')
    expect(postFormType('job', [{ name: 'bitcoin' }])).toBeUndefined()
    expect(postFormType('job', [])).toBeUndefined()
  })

  test('accepts plain sub-name strings', () => {
    expect(postFormType('job', ['jobs'])).toBe('job')
  })

  test('plural jobs type does not resolve outside the jobs turf', () => {
    expect(postFormType('jobs', [{ name: 'bitcoin' }])).toBeUndefined()
  })

  test('unknown types do not fall back to the job form', () => {
    expect(postFormType('foobar', [{ name: 'jobs' }])).toBeUndefined()
    expect(postFormType(undefined, [{ name: 'jobs' }])).toBeUndefined()
  })
})

describe('defaultPostType', () => {
  test('picks the single type of a one-type turf', () => {
    expect(defaultPostType([{ name: 'x', postTypes: ['LINK'] }])).toBe('link')
  })

  test('a JOB-only turf does not resolve to the job form', () => {
    expect(defaultPostType([{ name: 'x', postTypes: ['JOB'] }])).toBeUndefined()
  })

  test('multi-type or multi-turf does not resolve', () => {
    expect(defaultPostType([{ name: 'x', postTypes: ['LINK', 'JOB'] }])).toBeUndefined()
    expect(defaultPostType([{ name: 'a', postTypes: ['LINK'] }, { name: 'b', postTypes: ['LINK'] }])).toBeUndefined()
    expect(defaultPostType([])).toBeUndefined()
  })
})

describe('itemPostType', () => {
  test('maps item fields to the server post type', () => {
    expect(itemPostType({ url: 'https://x', subNames: ['monero'] })).toBe('LINK')
    expect(itemPostType({ url: null, subNames: ['monero'] })).toBe('DISCUSSION')
    expect(itemPostType({ url: null, pollCost: 10, subNames: ['monero'] })).toBe('POLL')
    expect(itemPostType({ url: null, bountyPiconeros: 100n, subNames: ['monero'] })).toBe('BOUNTY')
    expect(itemPostType({ url: null, subNames: ['jobs'] })).toBe('JOB')
  })

  test('returns undefined for comments, bios and missing items', () => {
    expect(itemPostType({ url: null, parentId: 1, subNames: ['monero'] })).toBeUndefined()
    expect(itemPostType({ url: null, bio: true })).toBeUndefined()
    expect(itemPostType(null)).toBeUndefined()
  })
})
