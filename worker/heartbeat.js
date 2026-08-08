import { writeFileSync } from 'fs'

export const WORKER_HEARTBEAT_PATH = process.env.WORKER_HEARTBEAT_PATH || '/tmp/worker-heartbeat'

export function writeWorkerHeartbeat () {
  try {
    writeFileSync(WORKER_HEARTBEAT_PATH, new Date().toISOString())
    return true
  } catch {
    return false
  }
}
