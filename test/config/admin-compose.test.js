/* eslint-env jest */
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'

test('the private Caddy listener is published only on loopback with read-only flag state', () => {
  const { services: { caddy } } = load(readFileSync('docker-compose.yml', 'utf8'))
  const bindings = caddy.ports.filter(port => String(port).split(':').at(-1) === '9443')
  expect(bindings).toEqual(['127.0.0.1:9443:9443'])
  expect(caddy.environment).toHaveProperty('ADMIN_GATE_SECRET')
  expect(caddy.volumes).toContain('./docker/caddy/maintenance-flag:/srv/maintenance-flag:ro')
})
