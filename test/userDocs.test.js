/* eslint-env jest */
import fs from 'fs'
import path from 'path'
import { parseFrontMatter, readDoc } from '../scripts/deploy_user_documentation.js'

const DOCS_DIR = path.join(process.cwd(), 'docs/user')
const DOCS = ['faq.md', 'guide.md', 'tos.md', 'privacy.md', 'copyright.md']
const EXPECTED_IDS = { 'faq.md': 349, 'guide.md': 81862, 'tos.md': 338393, 'privacy.md': 338369, 'copyright.md': 338453 }
const BANNED_VOCAB = /\bsats?\b|\bzap|\blightning\b|stacker news inc|outer\.space|hello@stacker|k00bideh/i

describe('deploy_user_documentation front matter', () => {
  it('parses title, id, and sub', () => {
    const content = '---\ntitle: Frequently Asked Questions\nid: 349\nsub: meta\n---\n\n# body\n'
    expect(parseFrontMatter(content)).toEqual({ title: 'Frequently Asked Questions', id: '349', sub: 'meta' })
  })
})

describe('user documentation docs', () => {
  it.each(DOCS)('%s has valid front matter and the expected id', (name) => {
    const doc = readDoc(name)
    expect(doc.title).toBeTruthy()
    expect(Number(doc.id)).toBe(EXPECTED_IDS[name])
    expect(doc.sub).toBe('meta')
    expect(doc.text.trim().length).toBeGreaterThan(0)
  })

  it('guide, tos, privacy, copyright use Stasher News vocabulary', () => {
    for (const name of ['guide.md', 'tos.md', 'privacy.md', 'copyright.md']) {
      const doc = readDoc(name)
      expect(doc.text).not.toMatch(BANNED_VOCAB)
    }
  })

  it('faq has no dead internal links or upstream operator handles', () => {
    const text = fs.readFileSync(path.join(DOCS_DIR, 'faq.md'), 'utf8')
    expect(text).not.toMatch(/\/wallets\/cowboy-credits|\/wallets\/reward-sats\/send|\/wallets\/logs|\(\/wallets\)|\(\/turf\)|\/top\/territories\/day|t\.me\/k00bideh|m\.stasher\.news/)
  })
})
