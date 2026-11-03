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
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
async function freePort () {
  const server = createServer()
  const port = await listen(server)
  await new Promise(resolve => server.close(resolve))
  return port
}

suite('admin Caddy routing (pinned binary)', () => {
  test.each(['Caddyfile', 'Caddyfile.prod'])('%s denies public admin paths, overwrites the private gate and bypasses maintenance', async file => {
    const secret = 'local-test-gate-secret-'.repeat(2)
    const env = { ...process.env, ADMIN_GATE_SECRET: secret }
    const config = JSON.parse(execFileSync(binary, ['adapt', '--adapter', 'caddyfile', '--config', `docker/caddy/${file}`], { env, encoding: 'utf8' }))
    const servers = Object.values(config.apps.http.servers)
    const privateServer = servers.find(server => server.listen.some(address => address.endsWith(':9443')))
    expect(privateServer).toBeDefined()
    const publicServer = servers.find(server => server.listen.some(address => address.endsWith(':443')))
    const redirectServer = servers.find(server => server.listen.some(address => address === ':80'))
    const directory = await mkdtemp(join(tmpdir(), 'admin-caddy-'))
    const upstream = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.setHeader('Strict-Transport-Security', 'max-age=31536000'); res.end(JSON.stringify(req.headers)) })
    let child
    try {
      const upstreamPort = await listen(upstream)
      const publicPort = await freePort()
      const privatePort = await freePort()
      const redirectPort = redirectServer ? await freePort() : null
      // Test the real adapted route tree over HTTP, not certificate issuance.
      // caddy validate separately checks both unmodified TLS configurations.
      delete config.apps.tls
      config.admin = { disabled: true }
      config.apps.http.servers = { public: publicServer, private: privateServer }
      if (redirectServer) {
        config.apps.http.servers.redirect = redirectServer
        redirectServer.listen = [`127.0.0.1:${redirectPort}`]
        redirectServer.automatic_https = { disable: true }
      }
      publicServer.listen = [`127.0.0.1:${publicPort}`]
      privateServer.listen = [`127.0.0.1:${privatePort}`]
      for (const server of [publicServer, privateServer]) {
        delete server.tls_connection_policies
        server.automatic_https = { disable: true }
      }
      function rewrite (node) {
        if (!node || typeof node !== 'object') return
        if (node.handler === 'reverse_proxy') node.upstreams = [{ dial: `127.0.0.1:${upstreamPort}` }]
        for (const [key, value] of Object.entries(node)) {
          if (value === '/srv/maintenance-flag') node[key] = directory
          else if (value === '/srv/maintenance') node[key] = resolve('docker/caddy/maintenance')
          else rewrite(value)
        }
      }
      rewrite(config)
      const path = join(directory, 'config.json')
      await writeFile(path, JSON.stringify(config))
      child = spawn(binary, ['run', '--config', path], { env, stdio: ['ignore', 'ignore', 'pipe'] })
      child.stderr.resume()
      const request = (port, path, host = 'stasher.news', forged = '') => new Promise((resolve, reject) => {
        const req = httpRequest({ hostname: '127.0.0.1', port, path, headers: { Host: host, 'X-Admin-Gate': forged } }, res => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', chunk => { body += chunk })
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: async () => JSON.parse(body) }))
        })
        req.on('error', reject)
        req.end()
      })
      const deadline = Date.now() + 5000
      while (true) {
        try { await request(privatePort, '/'); break } catch (error) {
          if (Date.now() >= deadline) throw error
          await delay(20)
        }
      }
      const hosts = file.endsWith('.prod') ? ['stasher.news', 'media.stasher.news', 'capture.stasher.news', 'www.stasher.news'] : ['stasher.news', 'custom.example']
      if (redirectPort) {
        for (const path of ['/admin', '/admin/settings', '/api/admin/graphql']) expect((await request(redirectPort, path)).status).toBe(404)
        expect((await request(redirectPort, '/')).status).toBe(308)
      }
      for (const host of hosts) {
        for (const path of ['/admin', '/admin/settings', '/api/admin', '/api/admin/graphql']) {
          for (const forged of ['', secret]) {
            const status = (await request(publicPort, path, host, forged)).status
            expect({ host, path, status }).toEqual({ host, path, status: 404 })
          }
        }
      }
      const publicResponse = await request(publicPort, '/', 'stasher.news', secret)
      const publicHeaders = await publicResponse.json()
      expect(publicResponse.headers['strict-transport-security']).toBe('max-age=31536000')
      expect(publicHeaders['x-admin-gate']).toBeUndefined()
      if (file.endsWith('.prod')) {
        for (const [host, path] of [['stasher.news', '/uploads'], ['media.stasher.news', '/'], ['capture.stasher.news', '/']]) {
          expect((await (await request(publicPort, path, host, secret)).json())['x-admin-gate']).toBeUndefined()
        }
      }
      // A rebinding page sends its own name as Host; it must never get the gate.
      for (const host of ['malicious.example', `malicious.example:${privatePort}`, 'stasher.news']) {
        for (const path of ['/admin', '/api/admin/graphql', '/_next/static/test.js']) {
          const status = (await request(privatePort, path, host, 'forged')).status
          expect({ host, path, status }).toEqual({ host, path, status: 404 })
        }
      }
      for (const host of ['localhost', `localhost:${privatePort}`, `127.0.0.1:${privatePort}`, 'localhost:8443']) {
        const response = await request(privatePort, '/admin', host)
        expect({ host, status: response.status }).toEqual({ host, status: 200 })
        expect((await response.json())['x-admin-gate']).toBe(secret)
      }
      const privateResponse = await request(privatePort, '/admin', 'localhost', 'forged')
      expect(privateResponse.status).toBe(200)
      expect(privateResponse.headers['strict-transport-security']).toBeUndefined()
      const privateHeaders = await privateResponse.json()
      expect(privateHeaders['x-admin-gate']).toBe(secret)
      expect(privateHeaders.host).toBe('stasher.news')
      expect(privateHeaders['x-forwarded-proto']).toBe('http')
      for (const path of ['/', '/api/graphql', '/administrator']) expect((await request(privatePort, path, 'localhost')).status).toBe(404)
      for (const path of ['/_next/static/test.js', '/fonts/test.woff2', '/icons/test.png']) expect((await request(privatePort, path, 'localhost')).status).toBe(200)
      await writeFile(join(directory, 'enabled'), 'test maintenance')
      expect((await request(publicPort, '/')).status).toBe(503)
      expect((await request(publicPort, '/admin')).status).toBe(404)
      expect((await request(privatePort, '/admin', 'localhost')).status).toBe(200)
    } finally {
      if (child && child.exitCode == null) { child.kill('SIGTERM'); await once(child, 'exit') }
      await new Promise(resolve => upstream.close(resolve))
      await rm(directory, { recursive: true, force: true })
    }
  }, 20000)
})
