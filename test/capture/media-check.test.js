/* eslint-env jest */
// native ESM (see jest.config.js transformIgnorePatterns): the `jest` object
// must be imported explicitly in ESM test files
import { jest } from '@jest/globals'
import http from 'node:http'

// 'tökèn' is 5 chars but 7 UTF-8 bytes (ö and è are 2 bytes each);
// 'tokèn' is also 5 chars but only 6 bytes. Equal char length with unequal
// byte length is the exact shape that made timingSafeEqual throw.
const TOKEN = 'tökèn'
const SAME_CHARS_DIFFERENT_BYTES = 'tokèn'

// TIMEOUT_HEAD/TIMEOUT_GET in capture/media-check.js
const HEAD_TIMEOUT_MS = 2000
const GET_TIMEOUT_MS = 10000

let mediaCheck
const prevEnv = {}

function saveEnv (name) {
  prevEnv[name] = {
    defined: Object.prototype.hasOwnProperty.call(process.env, name),
    value: process.env[name]
  }
}

function restoreEnv (name) {
  if (prevEnv[name].defined) process.env[name] = prevEnv[name].value
  else delete process.env[name]
}

beforeAll(async () => {
  // the module captures both at import time, and NODE_ENV=development
  // disables the SSRF guard so the loopback test server is reachable
  saveEnv('NODE_ENV')
  saveEnv('CAPTURE_MEDIA_TOKEN')
  process.env.CAPTURE_MEDIA_TOKEN = TOKEN
  process.env.NODE_ENV = 'development'
  const mod = await import('../../capture/media-check.js')
  mediaCheck = mod.default
})

afterAll(() => {
  // presence-aware: assigning undefined would leak the string "undefined"
  // into the shared jest worker process
  restoreEnv('NODE_ENV')
  restoreEnv('CAPTURE_MEDIA_TOKEN')
})

function mockRes () {
  const res = {}
  res.status = jest.fn(code => {
    res.statusCode = code
    return res
  })
  res.json = jest.fn(body => {
    res.body = body
    return res
  })
  return res
}

function mediaRequest (url, token) {
  return { params: { url }, headers: { 'x-capture-token': token } }
}

test('a token header of equal char length but unequal byte length is a 401, not a crash', async () => {
  // byte-length guard must short-circuit before timingSafeEqual, whose
  // RangeError on unequal buffer sizes used to escape the async express
  // handler and take the process down
  const res = mockRes()
  await mediaCheck(mediaRequest('http://example.com/img.png', SAME_CHARS_DIFFERENT_BYTES), res)
  expect(res.status).toHaveBeenCalledWith(401)
  expect(res.json).toHaveBeenCalledWith({ error: 'unauthorized' })
})

test('timeout timers do not outlive a request that ends early (upstream 401)', async () => {
  // both fetch helpers return early on 401/403 — the paths that used to skip
  // timer cleanup, leaving an armed abort timer that kills the process later
  const server = http.createServer((req, res) => {
    res.writeHead(401)
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}/img.png`
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout')
    const callsBefore = setTimeoutSpy.mock.calls.length
    try {
      const res = mockRes()
      await mediaCheck(mediaRequest(url, TOKEN), res)

      // every abort timer the handler scheduled (HEAD probe + GET fallback)
      // must be disarmed by the time the handler settles. _destroyed is what
      // clearTimeout sets; hasRef stays true on cleared timers in node >= 26
      const ourTimers = setTimeoutSpy.mock.calls
        .slice(callsBefore)
        .map((args, i) => ({ delay: args[1], timer: setTimeoutSpy.mock.results[callsBefore + i].value }))
        .filter(({ delay }) => delay === HEAD_TIMEOUT_MS || delay === GET_TIMEOUT_MS)
      expect(ourTimers.length).toBeGreaterThanOrEqual(2)
      for (const { timer } of ourTimers) {
        expect(timer._destroyed).toBe(true)
      }
    } finally {
      setTimeoutSpy.mockRestore()
    }
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
