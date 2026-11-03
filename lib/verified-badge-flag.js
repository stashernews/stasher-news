import { getSiteSettings } from '@/lib/siteSettings'

// Default remains off pending the award/pay redesign.
export async function isVerifiedBadgeEnabled (models) {
  return (await getSiteSettings(models)).verifiedBadgeEnabled
}
