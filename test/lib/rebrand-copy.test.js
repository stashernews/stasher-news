/* eslint-env jest */
import { COPY } from '@/lib/rebrand-copy'

describe('stealth copy', () => {
  it('speaks the approved stealth voice', () => {
    expect(COPY.logoutConfirm).toBe('Leaving? Run, then. I\'ll be here, cackling at the void.')
    expect(COPY.signupTagline).toBe('You found the back door. Welcome. The ghosts are friendly.')
    expect(COPY.newsletterGreeting).toBe('Fellow fugitives,')
    expect(COPY.mutesHeader).toBe('These souls crossed you. Now they can\'t even see you. Beautiful.')
    expect(COPY.welcomeEmailGreeting).toBe('So you made it. Impressive. Few do.')
    expect(COPY.welcomeEmailPs).toBe('P.S. They know you\'re here. Don\'t worry. We\'ve been watching them longer.')
    expect(COPY.liveStreamLine).toBe('Stasher News Live. The truth, streamed while it\'s still hot.')
    expect(COPY.loginResumeLine).toBe('Look who crawled back from the shadows. Welcome.')
    expect(COPY.loginPrompt).toBe('Fresh face. Unproven. Welcome anyway.')
  })

  it('stealth copy contains no emdashes', () => {
    for (const value of Object.values(COPY)) {
      expect(value).not.toMatch(/—/)
    }
  })
})
