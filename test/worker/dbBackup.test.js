/* eslint-env jest */

import { mkdtempSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pruneOldBackups, runBackupOnce } from '@/worker/dbBackup'

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
