// Next.js server-startup hook. Runs once per server process before any request.
// Used to fail fast on missing/insecure prod secrets. Skipped during `next build`
// by Next itself (NEXT_PHASE === 'phase-production-build'); the guard is redundant safety.
export async function register () {
  if (process.env.NEXT_PHASE === 'phase-production-build') return
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateEnv } = await import('./lib/env')
    validateEnv()
  }
}
