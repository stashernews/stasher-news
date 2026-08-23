/* eslint-env jest */
import { isVerifiedBadgeEnabled } from '@/lib/verified-badge-flag'

test('verified badge is disabled pending the award/pay redesign', () => {
  expect(isVerifiedBadgeEnabled()).toBe(false)
})
