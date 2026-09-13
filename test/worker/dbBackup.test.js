/* eslint-env jest */

import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pruneOldBackups, runBackupOnce, sha256File, verifyS3Upload } from '@/worker/dbBackup'

function tmpDir () {
  return mkdtempSync(join(tmpdir(), 'stasher-backup-'))
}

function touch (dir, name) {
  const f = join(dir, name)
  writeFileSync(f, 'x')
  return f
}

function backdateDays (file, days) {
  const t = (Date.now() / 1000) - days * 86400
  utimesSync(file, t, t)
}

test('pruneOldBackups removes only old .sql.gpg dumps, keeps recent ones, ignores non-backup files', async () => {
  const dir = tmpDir()
  const recent = touch(dir, 'stackernews-20260808T030000Z.sql.gpg')
  const old = touch(dir, 'stackernews-20250808T030000Z.sql.gpg')
  const strayTxt = touch(dir, 'notes.txt')
  const strayKey = touch(dir, 'keyring.gpg')
  backdateDays(old, 31)

  const pruned = await pruneOldBackups({ dir, retentionDays: 30 })

  expect(pruned).toEqual(['stackernews-20250808T030000Z.sql.gpg'])
  expect(existsSync(recent)).toBe(true)
  expect(existsSync(old)).toBe(false)
  expect(existsSync(strayTxt)).toBe(true)
  expect(existsSync(strayKey)).toBe(true)
})

test('pruneOldBackups is a no-op returning [] when the directory does not exist yet', async () => {
  const pruned = await pruneOldBackups({ dir: '/no/such/stasher-backup-dir-xyz', retentionDays: 30 })
  expect(pruned).toEqual([])
})

test('runBackupOnce runs the script with BACKUP_DIR, prunes, and uploads the produced file', async () => {
  const dir = tmpDir()
  const produced = touch(dir, 'stackernews-20260808T030000Z.sql.gpg')
  const stale = touch(dir, 'stackernews-20250808T030000Z.sql.gpg')
  backdateDays(stale, 40)

  const exec = jest.fn(async () => ({ stdout: produced + '\n' }))
  const uploaded = []
  const upload = jest.fn(async (f) => { uploaded.push(f) })

  const out = await runBackupOnce({ dir, retentionDays: 30, exec, upload })

  expect(exec).toHaveBeenCalledTimes(1)
  expect(exec.mock.calls[0][1].env.BACKUP_DIR).toBe(dir)
  expect(out.file).toBe(produced)
  expect(out.pruned).toEqual(['stackernews-20250808T030000Z.sql.gpg'])
  expect(existsSync(stale)).toBe(false)
  expect(uploaded).toEqual([produced])
})

test('runBackupOnce skips the S3 upload when no upload fn is provided', async () => {
  const dir = tmpDir()
  const produced = touch(dir, 'stackernews-20260808T030000Z.sql.gpg')
  const exec = jest.fn(async () => ({ stdout: produced }))

  const out = await runBackupOnce({ dir, retentionDays: 30, exec })

  expect(out.file).toBe(produced)
  expect(existsSync(produced)).toBe(true)
})

// --- Task: S3 upload verification --------------------------------------------

test('sha256File computes the base64 SHA-256 of the file contents', async () => {
  const dir = tmpDir()
  const f = join(dir, 'dump.sql.gpg')
  writeFileSync(f, 'hello stasher')
  const expected = createHash('sha256').update('hello stasher').digest('base64')
  await expect(sha256File(f)).resolves.toBe(expected)
})

function fakeS3Client (head) {
  return { send: jest.fn(async () => head) }
}

test('verifyS3Upload ok when size and checksum match', async () => {
  const dir = tmpDir()
  const f = touch(dir, 'stackernews-20260821T030000Z.sql.gpg') // contents 'x'
  const checksum = createHash('sha256').update('x').digest('base64')
  const size = 1
  const client = fakeS3Client({ ContentLength: size, ChecksumSHA256: checksum })
  await expect(verifyS3Upload({ client, bucket: 'b', key: 'k', filePath: f })).resolves.toEqual({ ok: true })
})

test('verifyS3Upload fails on size mismatch', async () => {
  const dir = tmpDir()
  const f = touch(dir, 'stackernews-20260821T030000Z.sql.gpg')
  const client = fakeS3Client({ ContentLength: 999, ChecksumSHA256: null })
  const out = await verifyS3Upload({ client, bucket: 'b', key: 'k', filePath: f })
  expect(out.ok).toBe(false)
  expect(out.reason).toContain('size mismatch')
})

test('verifyS3Upload fails on checksum mismatch', async () => {
  const dir = tmpDir()
  const f = touch(dir, 'stackernews-20260821T030000Z.sql.gpg') // contents 'x'
  const wrongChecksum = createHash('sha256').update('tampered').digest('base64')
  const client = fakeS3Client({ ContentLength: 1, ChecksumSHA256: wrongChecksum })
  const out = await verifyS3Upload({ client, bucket: 'b', key: 'k', filePath: f })
  expect(out.ok).toBe(false)
  expect(out.reason).toContain('checksum mismatch')
})

test('verifyS3Upload is ok with size-only when the remote reports no checksum', async () => {
  const dir = tmpDir()
  const f = touch(dir, 'stackernews-20260821T030000Z.sql.gpg') // contents 'x', size 1
  const client = fakeS3Client({ ContentLength: 1, ChecksumSHA256: undefined })
  await expect(verifyS3Upload({ client, bucket: 'b', key: 'k', filePath: f })).resolves.toEqual({ ok: true })
})

// --- dedicated backup-provider credentials ----------------------------------

describe('resolveBackupCredentials', () => {
  const KEYS = ['BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY']
  const saved = {}
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] } })
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

  test('returns explicit credentials when both are set', async () => {
    process.env.BACKUP_S3_ACCESS_KEY_ID = 'b2-key'
    process.env.BACKUP_S3_SECRET_ACCESS_KEY = 'b2-secret'
    const { resolveBackupCredentials } = await import('@/worker/dbBackup')
    expect(resolveBackupCredentials()).toEqual({ accessKeyId: 'b2-key', secretAccessKey: 'b2-secret' })
  })

  test('returns undefined when neither is set — default AWS credential chain preserved (backup job unchanged)', async () => {
    const { resolveBackupCredentials } = await import('@/worker/dbBackup')
    expect(resolveBackupCredentials()).toBeUndefined()
  })

  test('throws when only one is set', async () => {
    process.env.BACKUP_S3_ACCESS_KEY_ID = 'b2-key'
    const { resolveBackupCredentials } = await import('@/worker/dbBackup')
    expect(() => resolveBackupCredentials()).toThrow(/must be set together/)
  })
})
