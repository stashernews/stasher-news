/* eslint-env jest */

// lib/url.js builds IMGPROXY_URL_REGEXP from process.env.NEXT_PUBLIC_IMGPROXY_URL
// at import time, so the env is set at the top of this file and the module is
// imported dynamically inside each test (env-before-import, deliberately not
// beforeAll — mirrors test/lib/imgproxy-resign.test.js /
// test/worker/imgproxy.test.js). The no-env case deletes the var and re-imports
// a fresh module after jest.resetModules().

process.env.NEXT_PUBLIC_IMGPROXY_URL = 'https://imgprxy.test/'

const SOURCE = 'http://minio:9000/uploads/42'
const b64 = Buffer.from(SOURCE, 'utf-8').toString('base64url')
// base64url '_' (63) can only arise where a 3-byte group's last byte is '?'
// (0x3F), so this fixture carries TWO underscores in the payload to pin the
// global (not first-only) base64url decode fix
const UNDERSCORE_SOURCE = 'http://minio:9000/uploads/?ab?cd'
const b64u = Buffer.from(UNDERSCORE_SOURCE, 'utf-8').toString('base64url')

test('decodeProxyUrl handles multiple base64url underscores', async () => {
  const { decodeProxyUrl } = await import('@/lib/url')
  expect(decodeProxyUrl(`https://imgprxy.test/sig/rs:fit:640:360/${b64u}`)).toBe(UNDERSCORE_SOURCE)
})

test('canonicalizeMediaUrl decodes signed urls, passes everything else through', async () => {
  const { canonicalizeMediaUrl } = await import('@/lib/url')
  expect(canonicalizeMediaUrl(`https://imgprxy.test/sig/rs:fit:640:360/${b64}`)).toBe(SOURCE)
  expect(canonicalizeMediaUrl('https://stasher.news/uploads/42')).toBe('https://stasher.news/uploads/42')
  expect(canonicalizeMediaUrl(undefined)).toBe(undefined)
})

test('canonicalizeItemText decodes every signed url in markdown, leaves the rest intact', async () => {
  const { canonicalizeItemText } = await import('@/lib/url')
  const md = `![a](https://imgprxy.test/sig/rs:fit:640:360/${b64}) and ![b](https://imgprxy.test/sig2/rs:fit:960:540/${b64u}) plus [link](https://stasher.news/items/1)`
  expect(canonicalizeItemText(md)).toBe(`![a](${SOURCE}) and ![b](${UNDERSCORE_SOURCE}) plus [link](https://stasher.news/items/1)`)
})

// only matches with the signed shape BASE/<sig>/<options>/<b64> may be
// decoded — shorter remnants are innocent text mentioning the proxy
test('canonicalizeItemText leaves a bare mention of the imgproxy base alone', async () => {
  const { canonicalizeItemText } = await import('@/lib/url')
  const md = 'our image proxy is https://imgprxy.test/'
  expect(canonicalizeItemText(md)).toBe(md)
})

test('canonicalizeItemText leaves partial imgproxy paths alone', async () => {
  const { canonicalizeItemText } = await import('@/lib/url')
  const md = 'truncated url https://imgprxy.test/sig'
  expect(canonicalizeItemText(md)).toBe(md)
})

test('no imgproxy env -> helpers are no-ops', async () => {
  delete process.env.NEXT_PUBLIC_IMGPROXY_URL
  jest.resetModules()
  const fresh = await import('@/lib/url')
  const md = '![](https://imgprxy.test/sig/x)'
  expect(fresh.canonicalizeItemText(md)).toBe(md)
})
