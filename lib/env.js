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
  LOGIN_EMAIL_FROM: ['mailhog.dev', 'sndev@']
}

// Required in production. Each is empty/insecure-by-default in the tracked env files
// and silently breaks a money-moving, crypto, or auth path if left unset.
const PROD_REQUIRED = [
  'DATABASE_URL',
  'NEXTAUTH_SECRET',
  'JWT_SIGNING_PRIVATE_KEY',
  'EMAIL_SALT',
  'VIEWKEY_MASTER_KEY',
  'LWS_WEBHOOK_TOKEN',
  'MONERO_LWS_ADMIN_AUTH',
  'NEXTAUTH_URL',
  'NEXT_PUBLIC_URL',
  'LOGIN_EMAIL_SERVER',
  'LOGIN_EMAIL_FROM'
]

function hasDevMarker (key, v) {
  const markers = DEV_ONLY_MARKERS[key]
  if (!markers || v == null) return false
  return markers.some((m) => String(v).toLowerCase().includes(m))
}

export function validateEnv ({ env = process.env, nodeEnv = process.env.NODE_ENV } = {}) {
  if (nodeEnv !== 'production') return true
  const missing = PROD_REQUIRED.filter((k) => isInsecure(env[k]) || hasDevMarker(k, env[k]))
  if (missing.length) {
    logError({ missing }, 'FATAL: required environment variables missing or insecure in production')
    throw new Error(`Missing or insecure required environment variables in production: ${missing.join(', ')}`)
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
