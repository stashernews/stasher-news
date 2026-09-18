/* eslint-env jest */

// Editor canonicalization: signed imgproxy preview urls must never survive
// into editor state or markdown export. lib/url.js builds IMGPROXY_URL_REGEXP
// from process.env.NEXT_PUBLIC_IMGPROXY_URL at import time, so the env is set
// at the top of this file and the modules are imported dynamically inside
// each test (env-before-import).
// LexicalMediaVisitor needs no editor context — a stub node suffices.

process.env.NEXT_PUBLIC_IMGPROXY_URL = 'https://imgprxy.test/'

const SOURCE = 'http://minio:9000/uploads/42'
const SIGNED = `https://imgprxy.test/sig/rs:fit:640:360/${Buffer.from(SOURCE).toString('base64url')}`

// autolink media nodes have kind 'unknown' until the media check resolves;
// that's the branch that exports the src as plain text
const stubNode = (src, autolink = false) => ({
  isAutolink: () => autolink,
  getKind: () => (autolink ? 'unknown' : 'image'),
  getSrc: () => src,
  getAlt: () => 'alt',
  getTitle: () => null
})

const runVisitor = async (node) => {
  const { LexicalMediaVisitor } = await import('@/lib/lexical/mdast/visitors/media')
  let out = null
  LexicalMediaVisitor.visitLexicalNode({
    lexicalNode: node,
    actions: { appendToParent: (_p, n) => { out = n; return n } }
  })
  return out
}

test('image export canonicalizes signed src', async () => {
  const out = await runVisitor(stubNode(SIGNED))
  expect(out.type).toBe('image')
  expect(out.url).toBe(SOURCE)
})

test('autolink export canonicalizes signed src in text value', async () => {
  const out = await runVisitor(stubNode(SIGNED, true))
  expect(out.type).toBe('text')
  expect(out.value).toBe(SOURCE)
})

test('unsigned src passes through untouched', async () => {
  const out = await runVisitor(stubNode(SOURCE))
  expect(out.url).toBe(SOURCE)
})
