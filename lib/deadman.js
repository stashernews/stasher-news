import { alert } from '@/lib/alert'

// Dead-man alerts: fire when expected activity goes SILENT.
//  - worker liveness: the healthProbe job completes every 60s in a live worker;
//    no completed run for WORKER_STALE_MS (5m — same threshold as the compose
//    worker healthcheck) means the worker is dead or wedged, and every cron /
//    self-requeuing money chain has stopped with it. No error is thrown
//    anywhere in that scenario — this alert is the only signal.
//  - backup liveness: dbBackup completes on the 03:00 UTC cron; 26h of silence
//    means backups have stopped (dead cron, stuck schedule, pruned schedule).
//
// Null timestamps (no completed run yet — fresh stack) are never stale: unknown
// is not dead. alert() itself no-ops without ALERT_WEBHOOK_URL, so dev stacks
// stay silent by construction, and its 5-minute dedupe backstops the 60s health
// endpoint throttle.

export const WORKER_STALE_MS = 5 * 60 * 1000
export const BACKUP_STALE_MS = 26 * 60 * 60 * 1000

export function evaluateDeadman ({
  workerLastCompletedAt,
  backupLastCompletedAt,
  now = Date.now(),
  workerStaleMs = WORKER_STALE_MS,
  backupStaleMs = BACKUP_STALE_MS
}) {
  const workerStale = workerLastCompletedAt !== null &&
    (now - workerLastCompletedAt.getTime()) > workerStaleMs
  const backupStale = backupLastCompletedAt !== null &&
    (now - backupLastCompletedAt.getTime()) > backupStaleMs
  return { workerStale, backupStale }
}

export function deadmanAlerts ({
  workerStale,
  backupStale,
  workerLastCompletedAt,
  backupLastCompletedAt,
  alert: doAlert = alert
}) {
  if (workerStale) {
    doAlert('critical', 'worker heartbeat stale',
      `last completed healthProbe job: ${workerLastCompletedAt.toISOString()} — background jobs (payments, rewards, backups) are not running`,
      { dedupeKey: 'worker-heartbeat-stale' })
  }
  if (backupStale) {
    doAlert('critical', 'nightly backup missing',
      `last completed dbBackup job: ${backupLastCompletedAt.toISOString()} — offsite backups are stale`,
      { dedupeKey: 'dbBackup-silent' })
  }
}
