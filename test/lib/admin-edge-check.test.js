/* eslint-env jest */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.each([
  ['127.0.0.1:9443', '0', 0, '1', '0', '0'],
  ['0.0.0.0:9443', '0', 1, '0', '0', '0'],
  ['127.0.0.1:9443', '1', 1, '0', '0', '0'],
  ['127.0.0.1:9443', '0', 1, '1', '1', '0'],
  ['127.0.0.1:9443', '0', 1, '0', '0', '1']
])('edge checker records failures safely: binding=%s publicForgery=%s', (binding, forged, exit, recorded, recorderFailure, rebind) => {
  const directory = mkdtempSync(join(tmpdir(), 'admin-edge-'))
  try {
    const capture = join(directory, 'docker-args')
    const calls = join(directory, 'curl-calls')
    writeFileSync(join(directory, 'docker'), '#!/bin/sh\nif [ "$1" = compose ]; then printf "%s\\n" "$MOCK_BINDING"; else printf "%s\\n" "$@" > "$CAPTURE_ARGS"; exit "$MOCK_RECORDER_FAILURE"; fi\n', { mode: 0o755 })
    writeFileSync(join(directory, 'curl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CURL_CALLS"\nfor arg do url="$arg"; done\ncase "$url" in http://127.0.0.1:9443/*) case "$*" in *Host:*) if [ "$MOCK_REBIND" = 1 ]; then printf 200; else printf 404; fi;; *) printf 200;; esac;; *) case "$*" in *X-Admin-Gate:*) if [ "$MOCK_FORGED" = 1 ]; then printf 200; else printf 404; fi;; *) printf 404;; esac;; esac\n', { mode: 0o755 })
    const result = spawnSync('bash', ['scripts/admin-edge-check.sh'], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, MOCK_BINDING: binding, MOCK_FORGED: forged, MOCK_RECORDER_FAILURE: recorderFailure, MOCK_REBIND: rebind, CAPTURE_ARGS: capture, CURL_CALLS: calls, ADMIN_GATE_SECRET: 'secret-canary-never-print' },
      encoding: 'utf8'
    })
    expect(result.status).toBe(exit)
    expect(readFileSync(capture, 'utf8')).toContain(`ADMIN_EDGE_OK=${recorded}`)
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(6)
    for (const call of readFileSync(calls, 'utf8').trim().split('\n')) expect(call).toContain('--noproxy *')
    if (forged === '1') expect(result.stderr).toContain('https://stasher.news/admin: expected 404, received 200')
    if (rebind === '1') expect(result.stderr).toContain('http://127.0.0.1:9443/admin: expected 404, received 200')
    if (recorderFailure === '1') expect(result.stderr).toContain('could not persist check result')
    expect(`${result.stdout}${result.stderr}`).not.toContain('secret-canary-never-print')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('edge checker has valid bash syntax', () => {
  expect(() => execFileSync('bash', ['-n', 'scripts/admin-edge-check.sh'])).not.toThrow()
})
