/* eslint-env jest */
import { rebrandCopy } from '@/lib/rebrand-copy'

const LEGACY_EXPECT = {
  logoutConfirm: 'I reckon you want to logout?',
  signupTagline: 'We saved you a seat, pardner.',
  newsletterGreeting: 'Yeehaw,',
  mutesHeader: 'Well now, reckon these here are the folks you\'ve gone and silenced.',
  welcomeEmailGreeting: 'Yeehaw,',
  welcomeEmailPs: 'P.S. We\'re thrilled you\'re joinin\' the posse!',
  liveStreamLine: 'Stasher News Live is streaming this week\'s top stories',
  loginResumeLine: 'Nothing wrestles up a smile like a familiar face.',
  loginPrompt: 'New to town?'
}

describe('rebrandCopy', () => {
  it('returns the legacy cowboy voice when the flag is off', () => {
    const copy = rebrandCopy(false)
    for (const [key, value] of Object.entries(LEGACY_EXPECT)) {
      expect(copy[key]).toBe(value)
    }
  })

  it('returns the approved stealth voice when the flag is on', () => {
    const copy = rebrandCopy(true)
    expect(copy.logoutConfirm).toBe('Leaving? Run, then. I\'ll be here, cackling at the void.')
    expect(copy.signupTagline).toBe('You found the back door. Welcome. The ghosts are friendly.')
    expect(copy.newsletterGreeting).toBe('Fellow fugitives,')
    expect(copy.mutesHeader).toBe('These souls crossed you. Now they can\'t even see you. Beautiful.')
    expect(copy.welcomeEmailGreeting).toBe('So you made it. Impressive. Few do.')
    expect(copy.welcomeEmailPs).toBe('P.S. They know you\'re here. Don\'t worry. We\'ve been watching them longer.')
    expect(copy.liveStreamLine).toBe('Stasher News Live. The truth, streamed while it\'s still hot.')
    expect(copy.loginResumeLine).toBe('Look who crawled back from the shadows. Welcome.')
    expect(copy.loginPrompt).toBe('Fresh face. Unproven. Welcome anyway.')
  })

  it('stealth copy contains no emdashes', () => {
    for (const value of Object.values(rebrandCopy(true))) {
      expect(value).not.toMatch(/—/)
    }
  })

  it('stealth and legacy maps share the same keys', () => {
    expect(Object.keys(rebrandCopy(true)).sort()).toEqual(Object.keys(rebrandCopy(false)).sort())
  })
})
