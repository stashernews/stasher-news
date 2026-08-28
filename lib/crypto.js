import { createHash } from 'node:crypto'

export function hashEmail ({
  email,
  salt = process.env.EMAIL_SALT
}) {
  const saltedEmail = `${email.toLowerCase()}${salt}`
  return createHash('sha256').update(saltedEmail).digest('hex')
}

// Display-only hint persisted alongside emailHash so users can recognize
// which address is linked without the platform storing plaintext emails.
export function maskEmail ({ email }) {
  const [localPart = '', domain = ''] = String(email).split('@')
  return `${localPart[0] ?? ''}***@${domain}`
}
