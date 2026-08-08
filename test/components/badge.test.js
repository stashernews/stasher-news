/* eslint-env jest */
import { buildBadges } from '@/components/badge'
import { USER_ID } from '@/lib/constants'

// No React component harness exists in this repo (pure-logic tests only), so
// we test the extracted badge-list builder — the real behavior the Badges
// component renders — rather than forcing a render harness.

describe('buildBadges — Stasher identity', () => {
  test('verified-wallet check, coin, and flame in order', () => {
    const user = { id: 1, optional: { streak: 5, hasWallet: true, tippedRecently: true } }
    const badges = buildBadges(user)

    expect(badges.map(b => b.overlayText)).toEqual([
      'verified wallet',
      'tipped in the last 24 hours',
      '5 days'
    ])
    expect(badges[0].style).toEqual({ color: 'var(--theme-grey)' })
    expect(badges.every(b => b.icon)).toBe(true)
  })

  test('no verified-wallet check without a wallet', () => {
    const user = { id: 1, optional: { streak: 3, hasWallet: false, tippedRecently: true } }
    const badges = buildBadges(user)

    expect(badges.map(b => b.overlayText)).toEqual([
      'tipped in the last 24 hours',
      '3 days'
    ])
  })

  test('single day streak reads "1 day"', () => {
    const user = { id: 1, optional: { streak: 1, tippedRecently: false } }
    const badges = buildBadges(user)

    expect(badges.map(b => b.overlayText)).toEqual(['1 day'])
  })

  test('zero-length flame reads "new"', () => {
    const user = { id: 1, optional: { streak: 0, tippedRecently: false } }
    const badges = buildBadges(user)

    expect(badges.map(b => b.overlayText)).toEqual(['new'])
  })

  test('no flame when streak is null', () => {
    const user = { id: 1, optional: { streak: null, hasWallet: true, tippedRecently: false } }
    expect(buildBadges(user).map(b => b.overlayText)).toEqual(['verified wallet'])
  })

  test('no flame when streak is absent', () => {
    const user = { id: 1, optional: { tippedRecently: false } }
    expect(buildBadges(user)).toBeNull()
  })

  test('anon returns null', () => {
    expect(buildBadges({ id: USER_ID.anon, optional: { streak: 5, hasWallet: true } })).toBeNull()
  })

  test('bot override returns only the bot badge', () => {
    const user = { id: 1, optional: { streak: 5, hasWallet: true, tippedRecently: true } }
    const badges = buildBadges(user, { bot: true })

    expect(badges.map(b => b.overlayText)).toEqual(['posted as bot'])
  })

  test('no badges yields null', () => {
    const user = { id: 1, optional: { streak: null, hasWallet: false, tippedRecently: false } }
    expect(buildBadges(user)).toBeNull()
  })

  test('null user yields null', () => {
    expect(buildBadges(null)).toBeNull()
  })
})
