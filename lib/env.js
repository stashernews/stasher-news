import { logError } from '@/lib/logger'

const INSECURE_EXACT = new Set(['', 'test', 'password', 'secret'])
// substrings that indicate a placeholder default even when embedded in a value
// (e.g. DATABASE_URL="postgresql://sn:changeme@db:5432/..." — .env.development:92)
const INSECURE_SUBSTRING = ['changeme', 'change-me']

function isInsecure (v) {
  if (v == null) return true
  const s = String(v).trim()
  if (s === '' || INSECURE_EXACT.has(s.toLowerCase())) return true
  return INSECURE_SUBSTRING.some((sub) => s.toLowerCase().includes(sub))
}

// Dev-only markers that must never reach production, keyed by variable so a
// marker only fires where it means "dev default" (e.g. 'mailhog' in
// LOGIN_EMAIL_SERVER, but never in an unrelated var that legitimately
// contains the word).
const DEV_ONLY_MARKERS = {
  NEXTAUTH_URL: ['localhost', '127.0.0.1'],
  NEXT_PUBLIC_URL: ['localhost', '127.0.0.1'],
  LOGIN_EMAIL_SERVER: ['mailhog', 'localhost', '127.0.0.1'],
  LOGIN_EMAIL_FROM: ['mailhog.dev', 'sndev@'],
  OPENSEARCH_PASSWORD: ['dev-opensearch']
}

// Required in production. Each is empty/insecure-by-default in the tracked env files
// and silently breaks a money-moving, crypto, or auth path if left unset.
const PROD_REQUIRED = [
  'DATABASE_URL',
  'NEXTAUTH_SECRET',
  'JWT_SIGNING_PRIVATE_KEY',
  'EMAIL_SALT',
  'EMAIL_MASTER_KEY',
  'VIEWKEY_MASTER_KEY',
  'LWS_WEBHOOK_TOKEN',
  'MONERO_LWS_ADMIN_AUTH',
  'NEXTAUTH_URL',
  'NEXT_PUBLIC_URL',
  'LOGIN_EMAIL_SERVER',
  'LOGIN_EMAIL_FROM',
  'IMGPROXY_KEY',
  'IMGPROXY_SALT',
  'OPENSEARCH_PASSWORD',
  'CAPTURE_MEDIA_TOKEN',
  'REWARDS_PID_KEY'
]

// Variables that must not exist at all in production: dev-only overrides with
// no production meaning (any value, even a valid one, is a dev artifact).
const PROD_MUST_BE_UNSET = ['QUEST_DAY_EPOCH', 'QUEST_DAY_MS']

// Dev-default values that production must not carry — equality with any listed
// value fails validation. Covers the committed placeholder AND the imgproxy
// key/salt that were committed as dev defaults before the public release: they
// are gone from .env.development at HEAD but live on in git history, so the
// deny list keeps rejecting them (they are structurally valid hex, invisible
// to the insecure-value checks).
const PROD_MUST_DIFFER = {
  IMGPROXY_KEY: [
    'changeme',
    '73b5187ddbc1db70c74164dbcac1f40376413e2c0eedf55b70f10bd7abbe4240'
  ],
  IMGPROXY_SALT: [
    'changeme',
    'd0f1305e990d1c15b03c1989ac6c72f6a1c6d58b0a855894b7844b18f271671c'
  ],
  CAPTURE_MEDIA_TOKEN: ['dev-capture-token'],
  REWARDS_PID_KEY: ['stashernews-dev-pid-key'],
  EMAIL_MASTER_KEY: ['c3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3M=']
}

function hasDevMarker (key, v) {
  const markers = DEV_ONLY_MARKERS[key]
  if (!markers || v == null) return false
  return markers.some((m) => String(v).toLowerCase().includes(m))
}

export function validateEnv ({ env = process.env, nodeEnv = process.env.NODE_ENV } = {}) {
  if (nodeEnv !== 'production') return true
  const missing = PROD_REQUIRED.filter((k) => isInsecure(env[k]) || hasDevMarker(k, env[k]))
  const sameAsDev = Object.entries(PROD_MUST_DIFFER)
    .filter(([k, devVals]) => devVals.includes(env[k]))
    .map(([k]) => `${k}(=committed dev value)`)
  const notUnset = PROD_MUST_BE_UNSET
    .filter((k) => env[k] != null && env[k] !== '')
    .map((k) => `${k}(dev-only override set)`)
  const failures = [...missing, ...sameAsDev, ...notUnset]
  if (failures.length) {
    logError({ failures }, 'FATAL: required environment variables missing or insecure in production')
    throw new Error(`Missing or insecure required environment variables in production: ${failures.join(', ')}`)
  }
  return true
}

// The worker is a money-moving process: an unset or misspelled NODE_ENV
// silently disables validateEnv() above and can load .env.development in
// production. Require an explicit, recognized value.
const RECOGNIZED_NODE_ENVS = ['development', 'test', 'production']
export function assertExplicitNodeEnv ({ nodeEnv = process.env.NODE_ENV } = {}) {
  if (!RECOGNIZED_NODE_ENVS.includes(nodeEnv)) {
    throw new Error(
      `NODE_ENV must be explicitly set to one of ${RECOGNIZED_NODE_ENVS.join('|')} ` +
      `(got ${JSON.stringify(nodeEnv)}). Add NODE_ENV=development to .env.development ` +
      'and NODE_ENV=production to .env.production.')
  }
}
