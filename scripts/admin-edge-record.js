import { recordAdminEdge } from '../lib/admin/edge-check'

async function main () {
  const value = process.env.ADMIN_EDGE_OK
  if (value !== '0' && value !== '1') throw new Error('invalid edge result')
  const { default: models } = await import('../api/models')
  try {
    await recordAdminEdge(models, value === '1')
  } finally {
    await models.$disconnect()
  }
}

main().catch(() => {
  console.error('admin edge: result recording failed')
  process.exitCode = 1
})
