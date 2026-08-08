// Master-key provider seam for view-key envelope encryption (Task C1).
//
// `getMasterKey(version)` returns the 32-byte AES-256 master key that wraps
// each row's DEK (see viewkey.js). The provider is chosen by
// VIEWKEY_MASTER_KEY_PROVIDER (default `env`):
//   - `env`: a version→key registry read from VIEWKEY_MASTER_KEYS_V1, …_V2, …
//     (or a JSON VIEWKEY_MASTER_KEYS object), plus VIEWKEY_MASTER_KEY_CURRENT_VERSION.
//   - `kms`: AWS KMS-backed versioned data keys — seam only, throws until
//     implemented (see loadFromKms).
//
// Back-compat (critical): if only VIEWKEY_MASTER_KEY is set, it is treated as
// version 1 and current, so every existing MoneroViewKey row (all dekVersion=1)
// keeps decrypting unchanged. Multi-version support lets rotation (Task C2)
// retain old keys so envelopes written under a previous version still decrypt.
//
// Fail-closed: a missing/empty/wrong-length key throws rather than silently
// deriving a weak key for a security primitive.

const KEK_LEN = 32
const ENV_PROVIDER = 'env'
const KMS_PROVIDER = 'kms'
const LEGACY_KEY_ENV = 'VIEWKEY_MASTER_KEY'
const LEGACY_CURRENT = 1

let registry = null
let currentVersion = null

function decodeBase64Key (b64, what) {
  if (!b64) {
    throw new Error(`${what} is not set; refusing to derive a weak key`)
  }
  let buf
  try {
    buf = Buffer.from(b64, 'base64')
  } catch {
    throw new Error(`${what} is not valid base64`)
  }
  if (buf.length !== KEK_LEN) {
    throw new Error(`${what} must decode to ${KEK_LEN} bytes (got ${buf.length})`)
  }
  return buf
}

function loadVersionedEnv (map) {
  for (const name of Object.keys(process.env)) {
    const m = name.match(/^VIEWKEY_MASTER_KEYS_V(\d+)$/)
    if (!m) continue
    const value = process.env[name]
    if (!value) continue
    map.set(Number(m[1]), decodeBase64Key(value, name))
  }
}

function loadJsonRegistry (map) {
  const raw = process.env.VIEWKEY_MASTER_KEYS
  if (!raw) return
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('VIEWKEY_MASTER_KEYS is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('VIEWKEY_MASTER_KEYS must be a JSON object of version → base64 key')
  }
  for (const [k, value] of Object.entries(parsed)) {
    const v = Number(k)
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`VIEWKEY_MASTER_KEYS has invalid version key "${k}"`)
    }
    map.set(v, decodeBase64Key(value, `VIEWKEY_MASTER_KEYS["${k}"]`))
  }
}

function resolveCurrentVersion (map) {
  const raw = process.env.VIEWKEY_MASTER_KEY_CURRENT_VERSION
  if (raw !== undefined && raw !== '') {
    const v = Number(raw)
    if (!Number.isInteger(v) || !map.has(v)) {
      throw new Error(`VIEWKEY_MASTER_KEY_CURRENT_VERSION=${raw} has no matching key in the registry`)
    }
    return v
  }
  let max = 0
  for (const v of map.keys()) if (v > max) max = v
  return max
}

function loadFromEnv () {
  const map = new Map()
  loadVersionedEnv(map)
  if (map.size === 0) loadJsonRegistry(map)

  if (map.size > 0) {
    const current = resolveCurrentVersion(map)
    registry = map
    currentVersion = current
    return
  }

  if (process.env[LEGACY_KEY_ENV]) {
    registry = new Map([[LEGACY_CURRENT, decodeBase64Key(process.env[LEGACY_KEY_ENV], LEGACY_KEY_ENV)]])
    currentVersion = LEGACY_CURRENT
    return
  }

  throw new Error(`${LEGACY_KEY_ENV} is not set; refusing to derive a weak key`)
}

function loadFromKms () {
  // TODO(C5): resolve versioned data keys from KMS. Lazy-import the SDK once
  // implemented — `const { KMSClient, DecryptCommand } = await import('@aws-sdk/client-kms')` —
  // Decrypt each versioned ciphertext blob under VIEWKEY_MASTER_KEY_KMS_KEY_ID,
  // and warm the registry with the plaintext keys so getMasterKey stays
  // synchronous. Until then this is a seam that fails closed so no process
  // silently runs without a real master key.
  throw new Error('VIEWKEY_MASTER_KEY_PROVIDER=kms is not implemented yet; use the env provider (default)')
}

function loadFromProvider () {
  const provider = (process.env.VIEWKEY_MASTER_KEY_PROVIDER || ENV_PROVIDER).toLowerCase()
  if (provider === KMS_PROVIDER) {
    loadFromKms()
    return
  }
  if (provider !== ENV_PROVIDER) {
    throw new Error(`unknown VIEWKEY_MASTER_KEY_PROVIDER "${provider}" (expected "env" or "kms")`)
  }
  loadFromEnv()
}

function ensureLoaded () {
  if (registry !== null) return
  loadFromProvider()
}

export function getMasterKey (version) {
  ensureLoaded()
  const key = registry.get(version)
  if (!key) {
    throw new Error(`no master key registered for dekVersion ${version}`)
  }
  return key
}

export function getCurrentVersion () {
  ensureLoaded()
  return currentVersion
}

// Destructive in-process hot-swap used by the pre-C2 rotateMasterKey: registers
// `newKeyB64` as the next version, makes it current, and DROPS all prior
// versions — so envelopes sealed under an older key stop decrypting. Task C2
// replaces this with a non-destructive rotation that retains old versions.
export function setActiveKey (newKeyB64) {
  ensureLoaded()
  const decoded = decodeBase64Key(newKeyB64, 'rotateMasterKey: newKey')
  const nextVersion = currentVersion + 1
  registry = new Map([[nextVersion, decoded]])
  currentVersion = nextVersion
  return nextVersion
}
