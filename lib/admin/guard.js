import { safeEqual } from '@/lib/domains/auth'

function header (req, name) {
  return req?.headers?.get?.(name) ?? req?.headers?.[name]
}

export function isAdminRequest (req) {
  const secret = process.env.ADMIN_GATE_SECRET
  const received = header(req, 'x-admin-gate')
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || typeof received !== 'string') return false
  // safeEqual compares string lengths; guard UTF-8 byte lengths too so a
  // malformed non-ASCII header cannot throw inside timingSafeEqual.
  return Buffer.byteLength(received) === Buffer.byteLength(secret) && safeEqual(received, secret)
}

export function assertAdminMutationOrigin (req) {
  if (header(req, 'x-admin-client') !== '1') throw new Error('x-admin-client: 1 required')
}

export function isAdminPath (pathname) {
  return pathname === '/admin' || pathname.startsWith('/admin/') ||
    pathname === '/api/admin' || pathname.startsWith('/api/admin/') ||
    /^\/_next\/data\/[^/]+\/admin(?:\.json|\/.*\.json)$/.test(pathname)
}
