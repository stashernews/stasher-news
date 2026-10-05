import PgBoss from 'pg-boss'
import { logError } from '@/lib/logger'

// Explicitly owned, send-only pg-boss client for the operator CLIs (Task 10).
//
// `sndev monero distribute` and `sndev monero requeue --confirm` run outside
// the worker process, so they own no pg-boss connection. The shared completion
// path enqueues the delayed opsSweep follow-up through a boss, and this helper
// is the one place a CLI may create one: constructed only when the action
// actually needs the queue (`enabled`), the connection is closed in a finally
// so a failing action can never leak a live client, and a start/stop failure
// surfaces instead of silently dropping the scheduling.
//
// The client is SEND-ONLY by construction: noSupervisor (no maintenance loops)
// and noScheduling (no cron ownership) — the worker process owns all workers
// and schedules. Importing this module opens no connection.
const defaultCreateBoss = () => new PgBoss({
  connectionString: process.env.DATABASE_URL,
  noSupervisor: true,
  noScheduling: true
})

// Run `action(boss)` with a started queue client, or `action(undefined)` in
// disabled mode (dry-run / --no-send: a report that never touches the queue).
export async function withOpsSweepQueue (action, { enabled = true, createBoss = defaultCreateBoss } = {}) {
  if (!enabled) return action(undefined)
  const boss = createBoss()
  boss.on('error', logError)
  try {
    await boss.start()
    return await action(boss)
  } finally {
    await boss.stop({ graceful: true, timeout: 1000 })
  }
}
