// Separately encrypted TX-proof master-key registry escrow (Finding #1, Task 8).
//
//   npx tsx --tsconfig jsconfig.json scripts/backup-payment-proof-keys.js
//
// Encrypts the COMPLETE TX-proof registry — EVERY registered master-key
// version plus the current-version mapping and the format versions — into one
// GPG ciphertext for the escrow recipient (BACKUP_PUBLIC_KEY), and publishes
// it under an exclusive versioned timestamp name inside
// TXPROOF_MASTERKEY_BACKUP_DIR. Losing these keys is unrecoverable data loss
// for every payment proof, so the ciphertext MUST live in a failure domain
// separate from the DB backups: the script refuses any co-location with
// BACKUP_DIR (equal, parent, or child — in either direction, with symlinks
// resolved as far as they resolve).
//
// This script is a privileged OPERATIONAL entry point — never a boot/cron side
// effect — and it deliberately does NOT inherit the view-key backup coverage
// (scripts/backup-master-key.sh + the offsite masterkey leg are a DIFFERENT
// escrow): the operator must choose this TX escrow's location, prove the
// offsite leg actually transports AND decrypts it, and establish
// retention/decryptability before protected writers are enabled. See
// docs/ops/rewards-payment-proofs.md.
//
// Secrecy and integrity mechanics:
//   - the backup document exists ONLY in memory and reaches gpg ONLY via
//     stdin; no plaintext temp file is ever written;
//   - gpg is spawned WITHOUT a shell, with fixed arguments and no extra env;
//     gpg's stderr is drained and never echoed;
//   - ciphertext lands in an EXCLUSIVELY created 0600 partial file; the
//     versioned name is published atomically (exclusive hardlink + unlink)
//     only after stream completion AND a zero process exit — an existing
//     backup is never overwritten;
//   - on any failure, ONLY the partial file this run created is removed;
//   - output is the encrypted file path + the safe version count — never key
//     JSON, registry values, or gpg stderr contents.
//
// No actual backup is run as part of development; a real restore exercise
// needs separate operator authorization, exactly like actual backup access.
import { spawn as spawnProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import { canonicalPaymentJson } from '../api/monero/paymentClaims'
import { createPaymentProofKeyProvider } from '../api/monero/paymentProofKeys'

const BACKUP_VERSION = 1
const GPG_ARGS = ['--batch', '--yes', '--trust-model', 'always']

const ENV_MISSING = 'PROOF_BACKUP_ENV_MISSING'
const DIR_COLOCATED = 'PROOF_BACKUP_DIR_COLOCATED'
const GPG_FAILED = 'PROOF_BACKUP_GPG_FAILED'
const PUBLISH_EXISTS = 'PROOF_BACKUP_EXISTS'

const fail = code => { throw new Error(code) }

const requireEnv = (env, name) => {
  const value = env ? env[name] : undefined
  if (typeof value !== 'string' || value === '') fail(ENV_MISSING)
  return value
}

// `realpath -m` equivalent: resolve symlinks along the longest EXISTING prefix
// and keep the non-existing remainder lexical.
function resolvePathLenient (target) {
  const absolute = path.resolve(target)
  const parts = absolute.split(path.sep).filter(part => part !== '')
  let resolved = ''
  for (let index = 0; index < parts.length; index++) {
    const candidate = `${resolved}${path.sep}${parts[index]}`
    try {
      resolved = fs.realpathSync(candidate)
    } catch {
      // First missing component: nothing below it can exist either — keep the
      // remainder lexical.
      resolved = `${resolved}${path.sep}${parts.slice(index).join(path.sep)}`
      break
    }
  }
  return resolved === '' ? path.sep : resolved
}

const overlaps = (a, b) => a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)

const utcStamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

// Wait for process exit OR spawn failure; both must settle before publishing.
// `once` rejects when the 'error' event fires, so a spawn failure rejects here.
async function waitForExit (child) {
  try {
    const [code] = await Promise.race([once(child, 'exit'), once(child, 'error')])
    return code
  } catch {
    fail(GPG_FAILED)
  }
}

// Complete-write helper (final-review M4): writeSync may perform a SHORT
// write — loop until the whole ciphertext is on disk.
function writeAllSync (fd, buffer) {
  let written = 0
  while (written < buffer.length) {
    written += fs.writeSync(fd, buffer, written, buffer.length - written)
  }
}

// The gpg child never runs unbounded (final-review M4).
const GPG_TIMEOUT_MS = 30_000
// Minimal inherited environment for the gpg child (final-review M4): ambient
// secrets (credentials, key material, loader exports) never reach the crypto
// process; gpg needs only PATH/HOME to locate its binary and keyring.
const gpgChildEnv = env => {
  const child = {
    PATH: typeof env?.PATH === 'string' && env.PATH !== '' ? env.PATH : '/usr/bin:/bin'
  }
  if (typeof env?.HOME === 'string' && env.HOME !== '') child.HOME = env.HOME
  return child
}

/**
 * Validate the registry, build the closed backup document, encrypt it to the
 * escrow recipient via a shell-less gpg child (stdin only) and atomically
 * publish the exclusive 0600 ciphertext. All inputs are injected for tests:
 * `env` (registry + dir + recipient), `spawnGpg` (args, options) → child, and
 * `now` (clock for the versioned file name).
 *
 * @param {{env?: object, spawnGpg?: (args: string[], options: object) => object,
 *   now?: () => Date}} seams
 * @returns {Promise<{file: string, versions: number, currentVersion: number}>}
 */
export async function backupPaymentProofRegistry (seams = {}) {
  const {
    env = process.env,
    spawnGpg = (args, options) => spawnProcess('gpg', args, options),
    now = () => new Date()
  } = seams

  const backupDirEnv = requireEnv(env, 'TXPROOF_MASTERKEY_BACKUP_DIR')
  const recipient = requireEnv(env, 'BACKUP_PUBLIC_KEY')

  // Validate the COMPLETE registry through the provider: every version must
  // decode strictly and the current mapping must be registered (fixed
  // TXPROOF_* codes otherwise).
  const provider = createPaymentProofKeyProvider(env)
  const currentVersion = provider.getCurrentVersion()
  const keys = provider.getRegisteredVersions().map(version => ({
    version,
    masterKey: provider.getMasterKey(version).toString('base64')
  }))

  // Separate failure domains: refuse co-location with the DB backup dir in
  // either direction (equal / parent / child), symlinks resolved where they
  // resolve. This runs BEFORE any directory creation.
  const backupDir = resolvePathLenient(backupDirEnv)
  const dbBackupDir = env.BACKUP_DIR
  if (typeof dbBackupDir === 'string' && dbBackupDir !== '' &&
    overlaps(backupDir, resolvePathLenient(dbBackupDir))) {
    fail(DIR_COLOCATED)
  }

  fs.mkdirSync(backupDir, { recursive: true })
  const stamp = utcStamp(now())
  const finalPath = path.join(backupDir, `txproof-keys-v${currentVersion}-${stamp}.gpg`)
  const partialPath = `${finalPath}.${process.pid}.partial`

  // The closed in-memory backup document: every actual version, the current
  // mapping, and the format versions the escrow must stay decryptable with.
  const document = {
    registry: 'tx-proof',
    backupVersion: BACKUP_VERSION,
    currentVersion,
    keys,
    formats: { binding: 1, envelope: 1, payload: 1 }
  }
  const plaintext = Buffer.from(canonicalPaymentJson(document), 'utf8')

  const fd = fs.openSync(partialPath, 'wx', 0o600)
  try {
    let child
    try {
      child = spawnGpg([...GPG_ARGS, '--recipient', recipient, '--encrypt'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: gpgChildEnv(env),
        timeout: GPG_TIMEOUT_MS
      })
    } catch {
      fail(GPG_FAILED)
    }
    if (!child || !child.stdin || !child.stdout || !child.stderr || typeof child.on !== 'function') {
      fail(GPG_FAILED)
    }

    // The document reaches gpg ONLY via stdin; stderr is drained, never read
    // into any output; the ciphertext (stdout bytes) is the ONLY thing ever
    // written to disk. Stream completion AND the process exit are both
    // awaited before anything is published. The child's lifetime is BOUNDED
    // (final-review M4): a hung gpg is killed and the run fails instead of
    // blocking the operator forever. The child inherits only the minimal env
    // gpg needs (PATH, HOME, GPG_*/LOCALE overrides never cross the
    // boundary) so ambient secrets cannot leak into the crypto process.
    child.stderr.on('data', () => {})
    const ciphertextChunks = []
    child.stdout.on('data', chunk => ciphertextChunks.push(chunk))
    child.stdin.on('error', () => {}) // EPIPE if gpg dies early: the exit handles it
    child.stdin.end(plaintext)

    // Attach the exit/error listeners SYNCHRONOUSLY at spawn time (a fast
    // child may exit before we finish consuming stdout), then await stream
    // completion and the process exit before anything is published.
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { }
    }, GPG_TIMEOUT_MS)
    const exitPromise = waitForExit(child)
    try {
      await once(child.stdout, 'end')
      const exitCode = await exitPromise
      if (exitCode !== 0) fail(GPG_FAILED)

      writeAllSync(fd, Buffer.concat(ciphertextChunks))
      fs.fsyncSync(fd)
    } finally {
      clearTimeout(killTimer)
    }

    // Atomic, exclusive publication: hardlink refuses to overwrite an
    // existing backup, then the partial is unlinked (in finally).
    try {
      fs.linkSync(partialPath, finalPath)
    } catch (err) {
      if (err?.code === 'EEXIST') fail(PUBLISH_EXISTS)
      throw err
    }
    return { file: finalPath, versions: keys.length, currentVersion }
  } finally {
    try { fs.closeSync(fd) } catch { }
    // The partial is ALWAYS this run's own temp file: after a successful
    // hardlink publication it is a redundant second ciphertext; after any
    // failure it is the only artifact to remove. Either way, remove ONLY it.
    try { fs.unlinkSync(partialPath) } catch { }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  backupPaymentProofRegistry({ env: process.env })
    .then(result => {
      console.log(result.file)
      console.log(`versions=${result.versions}`)
    })
    .catch(err => {
      // Fixed codes only — an unexpected failure prints a fixed generic
      // label, never a raw driver/OS message (paths, errno text).
      const code = String(err?.message ?? '')
      console.error(/^[A-Z][A-Z0-9_]+$/.test(code) ? code : 'PROOF_BACKUP_FAILED')
      process.exit(1)
    })
}
