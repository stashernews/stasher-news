/* eslint-env jest */
import { execFileSync, spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

const binary = process.env.CADDY_BINARY
const suite = binary ? describe : describe.skip
const ONION_HOST = 'stasherabcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopq.onion'
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
async function freePort () {
  const server = createServer()
  const port = await listen(server)
  await new Promise(resolve => server.close(resolve))
  return port
}

// Rewrites the adapted config to run over HTTP against a local upstream and
// scratch maintenance flag dirs, so we exercise the real route tree without
// certificate issuance.
function rewrite (node, directory, upstreamPort) {
  if (!node || typeof node !== 'object') return
  if (node.handler === 'reverse_proxy') node.upstreams = [{ dial: `127.0.0.1:${upstreamPort}` }]
  for (const [key, value] of Object.entries(node)) {
    if (value === '/srv/maintenance-flag') node[key] = directory
    else if (value === '/srv/maintenance') node[key] = resolve('docker/caddy/maintenance')
    else rewrite(value, directory, upstreamPort)
  }
}

const request = (port, path, host) => new Promise((resolve, reject) => {
  const req = httpRequest({ hostname: '127.0.0.1', port, path, headers: { Host: host } }, res => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', chunk => { body += chunk })
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: async () => JSON.parse(body) }))
  })
  req.on('error', reject)
  req.end()
})

async function waitReady (port, path, host) {
  const deadline = Date.now() + 5000
  while (true) {
    try { await request(port, path, host); return } catch (error) {
      if (Date.now() >= deadline) throw error
      await delay(20)
    }
  }
}

suite('onion mirror Caddy routing (pinned binary)', () => {
  test('prod: :8081 is host-agnostic with clearnet parity; clearnet carries Onion-Location', async () => {
    const env = { ...process.env, ONION_HOST }
    const config = JSON.parse(execFileSync(binary, ['adapt', '--adapter', 'caddyfile', '--config', 'docker/caddy/Caddyfile.prod'], { env, encoding: 'utf8' }))
    const servers = Object.values(config.apps.http.servers)
    const onionServer = servers.find(server => server.listen.some(address => address.endsWith(':8081')))
    expect(onionServer).toBeDefined()
    const publicServer = servers.find(server => server.listen.some(address => address.endsWith(':443')))
    expect(publicServer).toBeDefined()

    const directory = await mkdtemp(join(tmpdir(), 'onion-caddy-'))
    const upstream = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.headers)) })
    let child
    try {
      const upstreamPort = await listen(upstream)
      const onionPort = await freePort()
      const publicPort = await freePort()
      // Test the real adapted route tree over HTTP, not certificate issuance.
      delete config.apps.tls
      config.admin = { disabled: true }
      config.apps.http.servers = { public: publicServer, onion: onionServer }
      for (const server of [publicServer, onionServer]) {
        delete server.tls_connection_policies
        server.automatic_https = { disable: true }
      }
      publicServer.listen = [`127.0.0.1:${publicPort}`]
      onionServer.listen = [`127.0.0.1:${onionPort}`]
      rewrite(config, directory, upstreamPort)
      const path = join(directory, 'config.json')
      await writeFile(path, JSON.stringify(config))
      child = spawn(binary, ['run', '--config', path], { env, stdio: ['ignore', 'ignore', 'pipe'] })
      child.stderr.resume()
      await waitReady(onionPort, '/', ONION_HOST)
      // host-agnostic: any Host routes through to the app, admin stays 404
      for (const host of [ONION_HOST, 'forged.example', 'stasher.news:8081']) {
        for (const p of ['/admin', '/admin/settings', '/api/admin', '/api/admin/graphql']) {
          expect({ host, p, status: (await request(onionPort, p, host)).status }).toEqual({ host, p, status: 404 })
        }
      }
      // webhook stays edge-404 on the onion path
      for (const p of ['/api/monero/webhook', '/api/monero/webhook/x']) {
        expect((await request(onionPort, p, ONION_HOST)).status).toBe(404)
      }
      // the app hop: Host preserved, truthful XFP http, gate never added, uploads proxied
      const onionHit = await request(onionPort, '/', ONION_HOST)
      expect(onionHit.status).toBe(200)
      const onionHeaders = await onionHit.json()
      expect(onionHeaders.host).toBe(ONION_HOST)
      expect(onionHeaders['x-forwarded-proto']).toBe('http')
      expect(onionHeaders['x-admin-gate']).toBeUndefined()
      expect((await request(onionPort, '/uploads', ONION_HOST)).status).toBe(200)
      // Onion-Location: present+exact on clearnet, absent on the onion
      expect((await request(publicPort, '/', 'stasher.news')).headers['onion-location']).toBe(`http://${ONION_HOST}/`)
      expect((await request(publicPort, '/items/123?x=1', 'stasher.news')).headers['onion-location']).toBe(`http://${ONION_HOST}/items/123?x=1`)
      for (const host of ['media.stasher.news', 'capture.stasher.news']) {
        expect((await request(publicPort, '/', host)).headers['onion-location']).toBeUndefined()
      }
      expect((await request(onionPort, '/', ONION_HOST)).headers['onion-location']).toBeUndefined()
      // maintenance parity on the onion listener
      await writeFile(join(directory, 'enabled'), 'on')
      expect((await request(onionPort, '/', ONION_HOST)).status).toBe(503)
    } finally {
      if (child && child.exitCode == null) { child.kill('SIGTERM'); await once(child, 'exit') }
      await new Promise(resolve => upstream.close(resolve))
      await rm(directory, { recursive: true, force: true })
    }
  }, 20000)

  test('prod: Onion-Location is absent on clearnet when ONION_HOST is unset (pre-key-day)', async () => {
    const env = { ...process.env }
    delete env.ONION_HOST
    const config = JSON.parse(execFileSync(binary, ['adapt', '--adapter', 'caddyfile', '--config', 'docker/caddy/Caddyfile.prod'], { env, encoding: 'utf8' }))
    const servers = Object.values(config.apps.http.servers)
    const publicServer = servers.find(server => server.listen.some(address => address.endsWith(':443')))
    expect(publicServer).toBeDefined()

    const directory = await mkdtemp(join(tmpdir(), 'onion-caddy-unset-'))
    const upstream = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.headers)) })
    let child
    try {
      const upstreamPort = await listen(upstream)
      const publicPort = await freePort()
      delete config.apps.tls
      config.admin = { disabled: true }
      config.apps.http.servers = { public: publicServer }
      delete publicServer.tls_connection_policies
      publicServer.automatic_https = { disable: true }
      publicServer.listen = [`127.0.0.1:${publicPort}`]
      rewrite(config, directory, upstreamPort)
      const path = join(directory, 'config.json')
      await writeFile(path, JSON.stringify(config))
      child = spawn(binary, ['run', '--config', path], { env, stdio: ['ignore', 'ignore', 'pipe'] })
      child.stderr.resume()
      await waitReady(publicPort, '/', 'stasher.news')
      // no Onion-Location on the clearnet host while ONION_HOST is unset/empty
      expect((await request(publicPort, '/', 'stasher.news')).headers['onion-location']).toBeUndefined()
      expect((await request(publicPort, '/items/123?x=1', 'stasher.news')).headers['onion-location']).toBeUndefined()
    } finally {
      if (child && child.exitCode == null) { child.kill('SIGTERM'); await once(child, 'exit') }
      await new Promise(resolve => upstream.close(resolve))
      await rm(directory, { recursive: true, force: true })
    }
  }, 20000)

  test('dev: :8081 exists, proxies to app:3000 with truthful XFP', () => {
    const config = JSON.parse(execFileSync(binary, ['adapt', '--adapter', 'caddyfile', '--config', 'docker/caddy/Caddyfile'], { encoding: 'utf8' }))
    const onion = Object.values(config.apps.http.servers).find(s => s.listen.some(a => a.endsWith(':8081')))
    expect(onion).toBeDefined()
    const json = JSON.stringify(onion)
    expect(json).toContain('app:3000')
    expect(json).toContain('http')
  })
})
