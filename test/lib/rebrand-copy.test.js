/* eslint-env jest */
import { COPY } from '@/lib/rebrand-copy'
import fs from 'node:fs'
import path from 'node:path'

const BANNED = [/stacker(?!\.news)/i] // bare 'stacker' (but never match the upstream domain)
const FILES = [
  'api/resolvers/user.js',
  'pages/search.js',
  'scripts/welcome.js',
  'components/territory-transfer.js',
  'components/territory-header.js',
  'components/territory-form.js',
  'components/footer.js',
  'components/snl.js',
  'scripts/newsletter.js'
]

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

describe('rebrand copy', () => {
  it.each(FILES)('%s contains no "stacker" in user-facing strings', (file) => {
    const src = fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8')
    // strip comments and non-string code crudely: only flag quoted strings containing the word
    const strings = src.match(/(['"`])(?:\\.|(?!\1).)*\1/g) || []
    for (const s of strings) {
      // skip strings that don't contain the word (nicer failure output)
      if (!/stacker/i.test(s)) continue
      for (const banned of BANNED) {
        expect(`${file}: ${s}`).not.toMatch(banned)
      }
    }
  })
})
