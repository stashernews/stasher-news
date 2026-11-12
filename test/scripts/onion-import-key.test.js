/* eslint-env jest */

// onion-import-key.sh must stage the key directory by ABSOLUTE path: a docker
// `-v` bind source cannot be relative, and the documented invocation is
// relative (`.onion-keys/<address>.onion` from wherever the operator's
// staging cwd happens to be). Regression: the staging step must receive the
// directory resolved against the caller's cwd, after validation. Docker is
// stubbed on PATH; the stub satisfies the verify/count calls and records the
// bind source it was handed for the final staging call.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'onion-import-key.sh')
// valid v3 shape per the script's ^[a-z2-7]{56}\.onion$ gate
const ADDRESS = 'a'.repeat(56) + '.onion'

let root
let binDir
let logFile
let resultFile

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'onion-import-root-'))
  binDir = path.join(root, 'bin')
  fs.mkdirSync(binDir)
  logFile = path.join(root, 'docker.log')
  resultFile = path.join(root, 'staged-src.txt')
  fs.writeFileSync(path.join(binDir, 'docker'), [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$FAKE_DOCKER_LOG"',
    'case "$1" in',
    '  image|rm) exit 0 ;;',
    'esac',
    'src=',
    'hsdir=',
    'prev=',
    'for a in "$@"; do',
    '  if [ "$prev" = "-v" ]; then',
    '    case "$a" in',
    // shell parameter expansions must land verbatim in the emitted script;
    // split so the JS string does not read as a template literal (lint rule)
    '      *:/src:ro) src=$' + '{a%:/src:ro} ;;',
    '      *:/tordata/hs) hsdir=$' + '{a%:/tordata/hs} ;;',
    '    esac',
    '  fi',
    '  prev=$a',
    'done',
    'if [ -n "$src" ]; then',
    '  printf \'%s\\n\' "$src" > "$FAKE_DOCKER_RESULT"',
    '  exit 0',
    'fi',
    'if [ -n "$hsdir" ]; then',
    '  basename "$FAKE_SRC" > "$hsdir/hostname"',
    '  cp "$FAKE_SRC/hs_ed25519_public_key" "$hsdir/hs_ed25519_public_key"',
    '  exit 0',
    'fi',
    '# hs-count helper: report an empty volume',
    'echo 0',
    ''
  ].join('\n'))
  fs.chmodSync(path.join(binDir, 'docker'), 0o755)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function stageKeyDir (relPieces) {
  const dir = path.join(root, ...relPieces, ADDRESS)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'hostname'), ADDRESS + '\n')
  fs.writeFileSync(path.join(dir, 'hs_ed25519_secret_key'), 'secret')
  fs.writeFileSync(path.join(dir, 'hs_ed25519_public_key'), 'pubkey')
  return dir
}

function runScript (cwd, arg, stagedDir) {
  return execFileSync('bash', [SCRIPT, arg], {
    cwd,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      TMPDIR: root,
      FAKE_DOCKER_LOG: logFile,
      FAKE_DOCKER_RESULT: resultFile,
      FAKE_SRC: stagedDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString()
}

describe('onion-import-key staging bind source', () => {
  test('documented relative invocation stages via an absolute bind source', () => {
    const staged = stageKeyDir(['rel-stage'])
    const out = runScript(root, path.join('rel-stage', ADDRESS), staged)
    expect(out).toContain('staged into volume')
    const recorded = fs.readFileSync(resultFile, 'utf8').trim()
    expect(recorded).toEqual(path.resolve(root, 'rel-stage', ADDRESS))
  })

  test('an absolute invocation resolves to the real (symlink-free) path', () => {
    const staged = stageKeyDir(['abs-stage'])
    const real = fs.realpathSync(staged)
    const out = runScript(root, staged, staged)
    expect(out).toContain('staged into volume')
    expect(fs.readFileSync(resultFile, 'utf8').trim()).toEqual(real)
  })

  test('a directory missing a key file is refused before docker runs', () => {
    const staged = path.join(root, 'incomplete', ADDRESS)
    fs.mkdirSync(staged, { recursive: true })
    fs.writeFileSync(path.join(staged, 'hs_ed25519_secret_key'), 'secret')
    expect(() => runScript(root, staged, staged)).toThrow(/missing hostname/)
    expect(fs.existsSync(logFile)).toBe(false)
  })
})
