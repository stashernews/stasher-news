/* eslint-env jest */
// Pure-logic tests for the multi-auth list cookie reader (repo convention:
// no React render harness — extract and test the real behavior). The SSR page
// render crashes if the corrupt
// cookie is parsed eagerly (SyntaxError out of AccountChooser), so the
// reader must fail closed to [] instead of throwing.
jest.mock('next-auth/jwt', () => ({
  encode: jest.fn(),
  decode: jest.fn()
}))

const path = require('path')
const ROOT = path.join(__dirname, '..', '..')

const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64')

describe('parseMultiAuthListCookie', () => {
  const loadAuth = () => {
    jest.resetModules()
    process.env.NEXTAUTH_SECRET = 'test-secret'
    return require(`${ROOT}/lib/auth`)
  }

  test('parses a valid list', () => {
    const { parseMultiAuthListCookie } = loadAuth()
    expect(parseMultiAuthListCookie(b64([{ id: 7, name: 'stale' }]))).toEqual([{ id: 7, name: 'stale' }])
  })

  test('returns [] when there is no cookie', () => {
    const { parseMultiAuthListCookie } = loadAuth()
    expect(parseMultiAuthListCookie(null)).toEqual([])
    expect(parseMultiAuthListCookie(undefined)).toEqual([])
    expect(parseMultiAuthListCookie('')).toEqual([])
  })

  test('returns [] for non-JSON garbage instead of throwing', () => {
    const { parseMultiAuthListCookie } = loadAuth()
    expect(() => parseMultiAuthListCookie('not-json')).not.toThrow()
    expect(parseMultiAuthListCookie('not-json')).toEqual([])
  })

  test('returns [] for valid JSON that is not an array', () => {
    const { parseMultiAuthListCookie } = loadAuth()
    expect(parseMultiAuthListCookie(b64({}))).toEqual([])
    expect(parseMultiAuthListCookie(b64(1))).toEqual([])
    expect(parseMultiAuthListCookie(b64('nope'))).toEqual([])
  })
})
