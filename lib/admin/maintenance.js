import { access, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const MAINTENANCE_DIRECTORY = join(process.cwd(), 'docker/caddy/maintenance-flag')

export async function readMaintenance (directory = MAINTENANCE_DIRECTORY) {
  try {
    await access(join(directory, 'enabled'))
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export async function writeMaintenance (enabled, reason, directory = MAINTENANCE_DIRECTORY) {
  const path = join(directory, 'enabled')
  if (!enabled) {
    try { await unlink(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
    return
  }
  const temporary = join(directory, `.enabled-${randomUUID()}`)
  try {
    await writeFile(temporary, `${new Date().toISOString()}\n${reason}\n`, { flag: 'wx', mode: 0o644 })
    await rename(temporary, path)
  } finally {
    // Preserve the write/rename error, not a secondary cleanup error.
    await unlink(temporary).catch(() => {})
  }
}
