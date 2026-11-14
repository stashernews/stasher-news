/* eslint-env jest */
import { contributorPostVersion, readContributorPost, setContributorEligibility } from '@/lib/admin/contributor-eligibility'

test('version includes fields changed by SQL writers without updatedAt', () => {
  const row = { id: 7, userId: 9, parentId: null, bio: false, deletedAt: null }
  for (const key of ['contributorDisqualifiedNote', 'contributorDisqualifiedReason', 'contributorDisqualifiedAt', 'contributorDisqualifiedNotifyAt']) {
    expect(contributorPostVersion(row)).not.toBe(contributorPostVersion({ ...row, [key]: 'changed' }))
  }
})

test.each([0, -1, 2147483648, '7', 1.5])('rejects invalid post id %s', async id => {
  await expect(readContributorPost({}, id)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
})

test('restoration cannot request an author notification', async () => {
  process.env.ALERT_WEBHOOK_URL = 'https://alerts.invalid/test'
  try {
    await expect(setContributorEligibility({ models: {}, id: 7, expectedVersion: 'a'.repeat(64), disqualified: false, notifyAuthor: true, reason: 'reviewed' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  } finally { delete process.env.ALERT_WEBHOOK_URL }
})
