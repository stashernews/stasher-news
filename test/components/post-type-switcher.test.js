/* eslint-env jest */
import { turfAllowsType } from '@/components/post-type-switcher'

const sub = (name, postTypes) => ({ name, postTypes })

describe('turfAllowsType', () => {
  test('unscoped /post takes every type but job', () => {
    for (const type of ['link', 'discussion', 'poll', 'bounty']) {
      expect(turfAllowsType(type, [])).toBe(true)
    }
    expect(turfAllowsType('job', [])).toBe(false)
  })

  test('a turf takes only its own post types', () => {
    const subs = [sub('monero', ['LINK', 'DISCUSSION'])]
    expect(turfAllowsType('link', subs)).toBe(true)
    expect(turfAllowsType('discussion', subs)).toBe(true)
    expect(turfAllowsType('poll', subs)).toBe(false)
    expect(turfAllowsType('bounty', subs)).toBe(false)
  })

  test('job belongs to ~jobs only', () => {
    expect(turfAllowsType('job', [sub('jobs', ['JOB'])])).toBe(true)
    expect(turfAllowsType('job', [sub('monero', ['JOB'])])).toBe(false)
    expect(turfAllowsType('discussion', [sub('jobs', ['JOB'])])).toBe(false)
  })
})
