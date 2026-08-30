/* eslint-env jest */
import {
  normalizePhrase, phraseError, generatePhrase, phraseKeypair,
  verifyChallengeSignature, phraseFingerprint, WORD_COUNT
} from '@/lib/recoveryPhrase'

const M1 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const M2 = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const PUB1 = 'bfb8cfa9a9e3a6336cb5cf6a51dc1953fbd34aefe826383b4916cd37c4cc4629'
const PUB2 = '1c1b12cc4a2e4a35e17f7ec880eddeb6d3cf693e022f0a91175e0b47cc3b0ee6'
const K1 = 'ab'.repeat(32)
const SIG1 = '80168edb3d714ae0357ac51f176f85527bb801d3acbd0d9dada20399813bd85bba09aed9d6d6d75d24637dfcf105f5a5336a9a7b5f2972b060481e667d705f0b'

describe('normalizePhrase', () => {
  it('lowercases, trims and collapses whitespace', () => {
    expect(normalizePhrase('  LEGAL   Winner\tthank YEAR  ')).toBe('legal winner thank year')
  })
})

describe('phraseError', () => {
  it('accepts valid phrases', () => {
    expect(phraseError(M1)).toBeNull()
    expect(phraseError('  ' + M2.toUpperCase() + '  ')).toBeNull()
  })
  it('flags wrong word counts', () => {
    expect(phraseError('abandon abandon').message).toContain('expected 12 words, got 2')
  })
  it('flags unknown words with a 1-based position', () => {
    const words = M1.split(' ')
    words[6] = 'notaword'
    const err = phraseError(words.join(' '))
    expect(err.index).toBe(7)
    expect(err.message).toContain('word 7')
  })
  it('flags valid words in a wrong order (checksum)', () => {
    const words = M1.split(' ')
    const swapped = [...words.slice(1), words[0]]
    expect(phraseError(swapped.join(' ')).message).toContain('checksum')
  })
})

describe('phraseKeypair determinism (pinned vectors)', () => {
  it('derives the pinned pubkeys', () => {
    expect(phraseKeypair(M1).pubkey).toBe(PUB1)
    expect(phraseKeypair(M2).pubkey).toBe(PUB2)
  })
  it('is invariant under normalization variants', () => {
    expect(phraseKeypair('  ' + M2.toUpperCase() + '  ').pubkey).toBe(PUB2)
  })
})

describe('challenge signatures', () => {
  it('roundtrips and pins the deterministic signature', () => {
    const kp = phraseKeypair(M1)
    const sig = kp.signChallenge(K1)
    expect(sig).toBe(SIG1)
    expect(verifyChallengeSignature({ k1: K1, pubkey: kp.pubkey, sig })).toBe(true)
  })
  it('rejects tampered k1, wrong key and malformed hex', () => {
    expect(verifyChallengeSignature({ k1: 'cd'.repeat(32), pubkey: PUB1, sig: SIG1 })).toBe(false)
    expect(verifyChallengeSignature({ k1: K1, pubkey: PUB2, sig: SIG1 })).toBe(false)
    expect(verifyChallengeSignature({ k1: 'zz', pubkey: 'zz', sig: 'zz' })).toBe(false)
  })
})

describe('generatePhrase', () => {
  it('produces 12 valid, unique words phrases', () => {
    const seen = new Set()
    for (let i = 0; i < 5; i++) {
      const phrase = generatePhrase()
      expect(phrase.split(' ')).toHaveLength(WORD_COUNT)
      expect(phraseError(phrase)).toBeNull()
      seen.add(phrase)
    }
    expect(seen.size).toBe(5)
  })
})

describe('phraseFingerprint', () => {
  it('shows the first 8 chars', () => {
    expect(phraseFingerprint(PUB1)).toBe('bfb8cfa9')
    expect(phraseFingerprint(null)).toBe('')
  })
})
