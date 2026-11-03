/* eslint-env jest */
import { execFileSync } from 'node:child_process'

test('remote operator scripts can build an env cookie without DATABASE_URL', () => {
  const env = { ...process.env, SITE_INVITE_CODES: 'alpha', NEXTAUTH_SECRET: 'test-secret', TSX_TSCONFIG_PATH: 'jsconfig.json' }
  delete env.DATABASE_URL
  const output = execFileSync(process.execPath, [
    'node_modules/tsx/dist/cli.mjs', '-e',
    "import { buildGateCookieHeader } from './lib/invite-gate'; console.log(buildGateCookieHeader())"
  ], { cwd: process.cwd(), env, encoding: 'utf8' })
  expect(output).toMatch(/sn_gate=[A-Za-z0-9_-]{43}/)
})
