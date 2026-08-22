import { exec as execCb } from 'node:child_process'
import { promises as fsp, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { alert } from '@/lib/alert'

// dbBackup — nightly encrypted DB backup (Phase 6 Task E1). Spawns
// scripts/backup-db.sh (pg_dump | gpg -> BACKUP_DIR), prunes local dumps older
// than BACKUP_RETENTION_DAYS, and optionally uploads the fresh dump to S3.
//
// Recurrence is owned by the pgboss.schedule row (cron nightly, migration
// 20260808160000_schedule_db_backup) — NOT a self-requeue — mirroring
// rewardsDistributor. Exports the testable per-run core + the pg-boss handler.

const pexec = promisify(execCb)
const DAY_MS = 24 * 60 * 60 * 1000
const BACKUP_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'backup-db.sh')

// Delete <db>-<ts>.sql.gpg files in `dir` whose mtime is older than
// retentionDays. Leaves non-backup files (.txt, stray .gpg keys, in-flight
// .tmp) untouched. Returns the basenames removed. No-op ([]) if dir is absent.
export async function pruneOldBackups ({ dir, retentionDays, now = Date.now() }) {
  const cutoff = now - retentionDays * DAY_MS
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const pruned = []
  for (const entry of entries) {
    if (!entry.isFile() || !/\.sql\.gpg$/.test(entry.name)) continue
    const full = join(dir, entry.name)
    const stat = await fsp.stat(full)
    if (stat.mtimeMs < cutoff) {
      await fsp.unlink(full)
      pruned.push(entry.name)
    }
  }
  return pruned
}

// Base64 SHA-256 of a file, streamed — backups can be large, never buffer them whole.
export async function sha256File (filePath) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve)
  })
  return hash.digest('base64')
}

// Post-upload verification: HEAD the object back and compare size + (when the
// remote reports one) the SHA-256 checksum against the local file. Catches
// truncation/corruption that a fire-and-forget PutObject would silently accept.
export async function verifyS3Upload ({ client, bucket, key, filePath }) {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }))
  const localStat = await fsp.stat(filePath)
  if (head.ContentLength !== localStat.size) {
    return { ok: false, reason: `size mismatch: local ${localStat.size} vs remote ${head.ContentLength}` }
  }
  if (head.ChecksumSHA256 && head.ChecksumSHA256 !== await sha256File(filePath)) {
    return { ok: false, reason: 'sha256 checksum mismatch' }
  }
  return { ok: true }
}

// Build an S3 upload fn only when BACKUP_S3_BUCKET is configured; otherwise
// undefined (runBackupOnce then skips the upload). Mirrors api/s3 dev handling:
// forcePathStyle + optional localstack endpoint in development.
function s3UploadIfConfigured () {
  const Bucket = process.env.BACKUP_S3_BUCKET
  if (!Bucket) return undefined
  const client = new S3Client({
    region: process.env.BACKUP_S3_REGION || 'us-east-1',
    forcePathStyle: process.env.NODE_ENV === 'development',
    ...(process.env.BACKUP_S3_ENDPOINT && { endpoint: process.env.BACKUP_S3_ENDPOINT })
  })
  const prefix = process.env.BACKUP_S3_PREFIX || 'backups/'
  return async (filePath) => {
    const Key = prefix + basename(filePath)
    await client.send(new PutObjectCommand({
      Bucket, Key, Body: createReadStream(filePath), ChecksumAlgorithm: 'SHA256'
    }))
    const verify = await verifyS3Upload({ client, bucket: Bucket, key: Key, filePath })
    if (!verify.ok) {
      alert('critical', 'dbBackup upload verification failed', `${Key}: ${verify.reason}`, { dedupeKey: 'dbBackup-verify' })
      throw new Error(`dbBackup: upload verification failed: ${verify.reason}`)
    }
    console.log(`dbBackup: uploaded + verified ${Key} to s3://${Bucket}`)
  }
}

// The testable per-run core: run the script (exec injectable so tests don't
// shell out), prune, and upload the freshly-produced dump if a fn is given.
// Returns { file, pruned }.
export async function runBackupOnce ({ dir, retentionDays = 30, exec = defaultExec, upload } = {}) {
  const cmd = `bash "${BACKUP_SCRIPT}"`
  const { stdout } = await exec(cmd, { env: { ...process.env, BACKUP_DIR: dir } })
  const file = stdout.trim().split('\n').filter(Boolean).pop()
  const pruned = await pruneOldBackups({ dir, retentionDays })
  if (upload && file) await upload(file)
  return { file, pruned }
}

async function defaultExec (cmd, opts) {
  return pexec(cmd, { ...opts, maxBuffer: 1024 * 1024 * 1024 })
}

// pg-boss handler. Runs one nightly backup. Recurrence is owned by the
// pgboss.schedule row; this does not self-requeue. Cron-created jobs carry
// pg-boss's default retryLimit 0, so ANY failure is permanent — alert here in
// addition to the jobWrapper permanent-failure alert (belt and braces: the
// nightly cadence is the only retry).
export async function dbBackup () {
  const dir = process.env.BACKUP_DIR || '/backups'
  const retentionDays = parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10)
  try {
    const out = await runBackupOnce({ dir, retentionDays, upload: s3UploadIfConfigured() })
    console.log(`dbBackup: wrote ${out.file}, pruned ${out.pruned.length} old backup(s)`)
  } catch (e) {
    console.error('dbBackup failed', e)
    alert('critical', 'dbBackup failed', String(e), { dedupeKey: 'dbBackup-failed' })
    throw e
  }
}
