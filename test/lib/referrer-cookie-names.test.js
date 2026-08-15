/* eslint-env jest */
// Static drift guard: the referrer cookies/header are written by proxy.js and
// read by the auth flow (pages/api/auth/[...nextauth].js) and SSR attribution
// (api/ssrApollo.js). These are stringly-typed contracts across files — the
// sn_ → st_ rebrand (commit 9fefced9) renamed the writer but not the reader,
// silently killing all referral attribution. If either side renames again,
// this test fails.
const fs = require('fs')
const path = require('path')

const root = process.cwd()
const proxySource = fs.readFileSync(path.join(root, 'proxy.js'), 'utf8')
const nextauthSource = fs.readFileSync(path.join(root, 'pages/api/auth/[...nextauth].js'), 'utf8')
const ssrApolloSource = fs.readFileSync(path.join(root, 'api/ssrApollo.js'), 'utf8')

const constantValue = (source, name) => {
  const match = source.match(new RegExp(`const ${name} = '([^']+)'`))
  if (!match) throw new Error(`missing constant ${name}`)
  return match[1]
}

describe('referrer cookie names', () => {
  test.each([
    { constName: 'ST_REFERRER', reader: nextauthSource, usage: 'req.cookies' },
    { constName: 'ST_REFEREE_LANDING', reader: nextauthSource, usage: 'req.cookies' }
  ])('$constName value is what the auth flow reads', ({ constName, reader, usage }) => {
    const value = constantValue(proxySource, constName)
    expect(reader).toContain(`${usage}.${value}`)
  })

  test.each(['ST_REFERRER', 'ST_REFERRER_NONCE', 'ST_REFEREE_LANDING'])(
    'proxy.js writes $constName',
    (constName) => {
      expect(proxySource).toContain(`'${constantValue(proxySource, constName)}'`)
    }
  )

  test('no legacy sn_ referrer cookie names remain in the write or read path', () => {
    expect(proxySource).not.toMatch(/sn_referrer|sn_referee_landing/)
    expect(nextauthSource).not.toMatch(/sn_referrer|sn_referee_landing/)
  })

  test('the referrer header set by proxy.js is the one ssrApollo reads', () => {
    expect(proxySource).toContain('x-stacker-news-referrer')
    expect(ssrApolloSource).toContain('x-stacker-news-referrer')
  })
})
