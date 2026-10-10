// Separate TX-proof master-key registry (Finding #1, Task 2).
//
// The registry maps positive integer key versions to 32-byte AES-256 master
// keys used to wrap payment-proof DEKs (see paymentProofCrypto.js). It is
// deliberately separate from the view-key registry in masterkey.js: no
// fallback to VIEWKEY_* (or anything else), no implicit highest-version
// selection, and an explicit mandatory current version. Providers for other
// backends (`kms`, …) are refused with the fixed TXPROOF_PROVIDER_UNSUPPORTED
// code until one is actually implemented — there is no speculative KMS seam.
//
// Laziness: importing this module has no side effects and creating a provider
// never reads registry values. Even registry *structure* (the version list and
// current version) is only parsed on the first method call, so legacy
// recorded-delivery recovery and public read paths never need configured TX
// keys merely by importing modules that default to this provider. Key bytes
// are decoded defensively and per call: the registry stores only the original
// base64 strings, so getMasterKey hands out a fresh buffer every time and no
// registry-owned buffer can ever be mutated by a caller.
//
// Fail-closed: every problem surfaces as one fixed uppercase error code, never
// an underlying library message, and never any key material.

const PROVIDER_ENV = 'TXPROOF_MASTER_KEY_PROVIDER'
const JSON_ENV = 'TXPROOF_MASTER_KEYS'
const CURRENT_ENV = 'TXPROOF_MASTER_KEY_CURRENT_VERSION'
const PER_VERSION_NAME = /^TXPROOF_MASTER_KEYS_V([1-9][0-9]*)$/

const KEY_BYTES = 32
const ENV_PROVIDER = 'env'

// Strict base64: canonical alphabet, exact grouping, and no non-canonical
// trailing bits (re-encoding must reproduce the input byte for byte).
const BASE64_ALPHABET = /^[A-Za-z0-9+/]+={0,2}$/
const CANONICAL_POSITIVE = /^[1-9][0-9]*$/

const UNSUPPORTED = 'TXPROOF_PROVIDER_UNSUPPORTED'
const REGISTRY_INVALID = 'TXPROOF_REGISTRY_INVALID'
const KEY_INVALID = 'TXPROOF_REGISTRY_KEY_INVALID'
const VERSION_INVALID = 'TXPROOF_KEY_VERSION_INVALID'
const VERSION_MISSING = 'TXPROOF_KEY_VERSION_MISSING'

function fail (code) {
  throw new Error(code)
}

// Env entries are "absent" when undefined/null/empty (docker compose emits
// empty strings for unset vars); anything else must be a string.
function readEnv (env, name) {
  const value = env ? env[name] : undefined
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') fail(REGISTRY_INVALID)
  return value
}

function decodeStrictBase64Key (value) {
  if (value.length % 4 !== 0 || !BASE64_ALPHABET.test(value)) fail(KEY_INVALID)
  const key = Buffer.from(value, 'base64')
  if (key.length !== KEY_BYTES || key.toString('base64') !== value) fail(KEY_INVALID)
  return key
}

// Parse the registry structure exactly once per provider: which versions exist
// and which one is current. Key VALUES are kept as raw strings — decoding
// happens only in getMasterKey, so metadata access never requires valid keys.
// The JSON registry and per-version env vars are mutually exclusive single
// sources; both at once is an ambiguous configuration that must refuse.
function parseRegistry (env) {
  const jsonRaw = readEnv(env, JSON_ENV)
  const perVersion = []
  for (const name of Object.keys(env ?? {})) {
    const match = PER_VERSION_NAME.exec(name)
    if (match !== null && readEnv(env, name) !== null) {
      // Per-version names get the same canonical positive safe-integer gate
      // as JSON entries (final-review M2): `Number(...)` on a huge or
      // non-canonical numeric suffix must never be accepted silently.
      const version = Number(match[1])
      if (!CANONICAL_POSITIVE.test(match[1]) || !Number.isSafeInteger(version)) fail(REGISTRY_INVALID)
      perVersion.push({ version, value: env[name] })
    }
  }

  if (jsonRaw !== null && perVersion.length > 0) fail(REGISTRY_INVALID)

  const stored = new Map()
  if (jsonRaw !== null) {
    let parsed
    try {
      parsed = JSON.parse(jsonRaw)
    } catch {
      fail(REGISTRY_INVALID)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail(REGISTRY_INVALID)
    for (const [rawVersion, value] of Object.entries(parsed)) {
      if (!CANONICAL_POSITIVE.test(rawVersion) || typeof value !== 'string') fail(REGISTRY_INVALID)
      const version = Number(rawVersion)
      if (!Number.isSafeInteger(version)) fail(REGISTRY_INVALID)
      stored.set(version, value)
    }
  } else {
    for (const entry of perVersion) stored.set(entry.version, entry.value)
  }
  if (stored.size === 0) fail(REGISTRY_INVALID)

  const currentRaw = readEnv(env, CURRENT_ENV)
  if (currentRaw === null || !CANONICAL_POSITIVE.test(currentRaw)) fail(REGISTRY_INVALID)
  const current = Number(currentRaw)
  if (!Number.isSafeInteger(current)) fail(REGISTRY_INVALID)
  if (!stored.has(current)) fail(VERSION_MISSING)

  return { stored, current }
}

function normalizeVersionArgument (version) {
  if (typeof version === 'number') {
    if (!Number.isSafeInteger(version) || version <= 0) fail(VERSION_INVALID)
    return version
  }
  if (typeof version === 'string' && CANONICAL_POSITIVE.test(version)) {
    const normalized = Number(version)
    if (Number.isSafeInteger(normalized)) return normalized
  }
  fail(VERSION_INVALID)
}

/**
 * Build a lazy TX-proof master-key provider over an env-like object (the
 * production entry points pass `process.env`; tests pass synthetic objects).
 * Only `TXPROOF_MASTER_KEY_PROVIDER` is validated at creation; everything
 * else is deferred to the first method call.
 *
 * Env contract:
 *   TXPROOF_MASTER_KEY_PROVIDER      `env` (default); anything else is refused
 *   TXPROOF_MASTER_KEYS              JSON object version→strict base64 32-byte key
 *   TXPROOF_MASTER_KEYS_V<n>         per-version alternative (exclusive with the JSON form)
 *   TXPROOF_MASTER_KEY_CURRENT_VERSION  mandatory canonical positive integer, must be registered
 *
 * @param {object} env
 * @returns {{getMasterKey: (version: number|string) => Buffer, getCurrentVersion: () => number, getRegisteredVersions: () => number[]}}
 */
export function createPaymentProofKeyProvider (env) {
  const provider = env ? env[PROVIDER_ENV] : undefined
  if (provider !== undefined && provider !== null && provider !== '' && provider !== ENV_PROVIDER) {
    fail(UNSUPPORTED)
  }

  let registry = null
  const load = () => {
    if (registry === null) registry = parseRegistry(env)
    return registry
  }

  return {
    // Returns a fresh 32-byte buffer on every call: the registry only ever
    // holds the base64 string, so decoding allocates a new buffer that no
    // other caller can observe or mutate.
    getMasterKey (version) {
      const normalized = normalizeVersionArgument(version)
      const value = load().stored.get(normalized)
      if (value === undefined) fail(VERSION_MISSING)
      return decodeStrictBase64Key(value)
    },
    getCurrentVersion () {
      return load().current
    },
    // Version numbers only — never key material, and a fresh array each call.
    getRegisteredVersions () {
      return [...load().stored.keys()].sort((a, b) => a - b)
    }
  }
}
