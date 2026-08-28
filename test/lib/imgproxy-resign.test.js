/* eslint-env jest */

// stored imgproxy paths are self-describing: /<signature>/<options>/<b64url-source>.
// verifyImgproxyPath checks the embedded signature; resignImgproxyPath recomputes
// ONLY the signature over the byte-identical target, so stored signed paths
// survive IMGPROXY_KEY rotations without re-deriving source or options.
//
// lib/imgproxy.js reads IMGPROXY_SALT/IMGPROXY_KEY into consts at import time,
// so the module is imported dynamically AFTER the env is set at the top of this
// file (env-before-import, deliberately not beforeAll). The rotation case uses
// jest.resetModules() + re-import with a new key (mirrors test/worker/imgproxy.test.js).

process.env.NEXT_PUBLIC_IMGPROXY_URL = 'https://imgprxy.test/'
process.env.IMGPROXY_SALT = 'a'.repeat(64)
process.env.IMGPROXY_KEY = 'b'.repeat(64)

const SOURCE = 'http://minio:9000/uploads/3536'

it('verifyImgproxyPath accepts a freshly signed path', async () => {
  const { createImgproxyPath, verifyImgproxyPath } = await import('@/lib/imgproxy')
  expect(verifyImgproxyPath(createImgproxyPath({ url: SOURCE, options: '/rs:fit:640:360' }))).toBe(true)
})

it('resignImgproxyPath is identity on valid paths', async () => {
  const { createImgproxyPath, resignImgproxyPath } = await import('@/lib/imgproxy')
  const path = createImgproxyPath({ url: SOURCE, options: '/rs:fit:640:360' })
  expect(resignImgproxyPath(path)).toBe(path)
})

it('non-path values pass through untouched', async () => {
  const { verifyImgproxyPath, resignImgproxyPath } = await import('@/lib/imgproxy')
  for (const v of ['', null, undefined, 'https://x.test/a', 'nopath']) {
    expect(resignImgproxyPath(v)).toBe(v)
    expect(verifyImgproxyPath(v)).toBe(true) // not checkable, not failing
  }
})

it('after key rotation, old path fails verify and re-signs to a valid path with identical target', async () => {
  const { createImgproxyPath } = await import('@/lib/imgproxy')
  const oldPath = createImgproxyPath({ url: SOURCE, options: '/rs:fit:640:360' })
  process.env.IMGPROXY_KEY = 'c'.repeat(64)
  jest.resetModules()
  const fresh = await import('@/lib/imgproxy')
  expect(fresh.verifyImgproxyPath(oldPath)).toBe(false)
  const resigned = fresh.resignImgproxyPath(oldPath)
  expect(resigned).not.toBe(oldPath)
  expect(fresh.verifyImgproxyPath(resigned)).toBe(true)
  // embedded source + options preserved verbatim
  const target = (p) => p.slice(p.indexOf('/', 1))
  expect(target(resigned)).toBe(target(oldPath))
})
