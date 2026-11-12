/* eslint-env jest */
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'

const overlay = load(readFileSync('docker-compose.onion.yml', 'utf8'))

test('onion-tor is a hardened ingress source with no published ports', () => {
  const tor = overlay.services['onion-tor']
  expect(tor).toBeDefined()
  expect(tor.ports).toBeUndefined()
  expect(tor.read_only).toBe(true)
  expect(tor.security_opt).toContain('no-new-privileges:true')
  expect(tor.volumes).toContain('onion_tordata:/tordata')
  expect(tor.restart).toBe('unless-stopped')
  expect(String(tor.healthcheck.test)).toContain('socks5-hostname')
  expect(String(tor.healthcheck.test)).toContain('/tordata/hs/hostname')
  // shares caddy's netns: torrc targets 127.0.0.1:8081 = the caddy onion listener
  expect(tor.network_mode).toBe('service:caddy')
})

test('the caddy service receives ONION_HOST from required interpolation', () => {
  const caddy = overlay.services.caddy
  expect(caddy).toBeDefined()
  expect(JSON.stringify(caddy.environment)).toContain('ONION_HOST')
  expect(JSON.stringify(caddy.environment)).toContain(':?')
})

test('the overlay declares the key volume', () => {
  expect(overlay.volumes).toHaveProperty('onion_tordata')
})

test('the onion overlay is gitignore-negated, not force-added', () => {
  expect(readFileSync('.gitignore', 'utf8')).toMatch(/^!docker-compose\.onion\.yml$/m)
})

test('the miner is profile-gated, local-only, and writes to the gitignored dir', () => {
  const miner = overlay.services['onion-miner']
  expect(miner).toBeDefined()
  expect(miner.profiles).toEqual(['onion-miner'])
  expect(miner.volumes).toContain('./.onion-keys:/out')
  // eslint-disable-next-line no-template-curly-in-string -- asserting the literal compose interpolation
  expect(miner.user).toBe('${CURRENT_UID:-1000}:${CURRENT_GID:-1000}')
})

test('onion-tor has NO profile (starts whenever the overlay is attached)', () => {
  expect(overlay.services['onion-tor'].profiles).toBeUndefined()
})

test('.env.development and .env.production define no ONION_HOST line', () => {
  // the overlay's ${ONION_HOST:?…} gate must stay unmet until key day; any
  // value in a committed env file (even a placeholder) silently satisfies it,
  // because .env.development is the first --env-file of every documented chain
  for (const f of ['.env.development', '.env.production']) {
    expect(readFileSync(f, 'utf8')).not.toMatch(/^ONION_HOST=/m)
  }
})

test('.onion-keys is gitignored', () => {
  expect(readFileSync('.gitignore', 'utf8')).toMatch(/^\.onion-keys\/$/m)
})
