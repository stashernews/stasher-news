import { readMaintenance } from './maintenance'
import { AdminError } from './validate'

export async function readAdminState (models, { lock = false, maintenanceDirectory } = {}) {
  if (lock) {
    await models.$queryRaw`SELECT id FROM "PlatformFeeConfig" WHERE id = 1 FOR UPDATE`
    await models.$queryRaw`SELECT id FROM "SiteSettings" WHERE id = 1 FOR UPDATE`
  }
  const [fees, settings, snl, maintenance] = await Promise.all([
    models.platformFeeConfig.findUnique({ where: { id: 1 } }),
    models.siteSettings.findUnique({ where: { id: 1 } }),
    models.snl.findFirst({ orderBy: { id: 'asc' } }),
    readMaintenance(maintenanceDirectory)
  ])
  if (!fees || !settings) throw new AdminError('SETTINGS_UNAVAILABLE', 'settings singleton is missing')
  if (lock && snl) await models.$queryRaw`SELECT id FROM "Snl" WHERE id = ${snl.id} FOR UPDATE`
  return { state: { ...fees, ...settings, 'snl.live': !!snl?.live, 'snl.message': snl?.message ?? '', maintenance }, snlId: snl?.id }
}
