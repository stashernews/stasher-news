/* eslint-env jest */
import { FIELD_BY_KEY, ANNOUNCEMENT_MAX_LENGTH } from '@/lib/admin/fields'
import { parseFieldValue, formatFieldValue } from '@/lib/admin/units'
import { validateChanges } from '@/lib/admin/validate'
import resolvers from '@/api/resolvers/admin'

const message = FIELD_BY_KEY.get('snl.message')
const live = FIELD_BY_KEY.get('snl.live')

test('the banner switch and message are one Announcement group on the snl row', () => {
  expect(live).toMatchObject({ label: 'Announcement banner', store: 'snl', column: 'live', group: 'Announcement' })
  expect(message).toMatchObject({ label: 'Announcement message', type: 'text', store: 'snl', column: 'message', maxLength: ANNOUNCEMENT_MAX_LENGTH })
})

test('messages are single-line plain text within the length limit', () => {
  expect(parseFieldValue(message, '  Scheduled   maintenance\nat 22:00 UTC  ')).toBe('Scheduled maintenance at 22:00 UTC')
  expect(parseFieldValue(message, '')).toBe('')
  expect(parseFieldValue(message, 'x'.repeat(ANNOUNCEMENT_MAX_LENGTH))).toHaveLength(ANNOUNCEMENT_MAX_LENGTH)
  expect(() => parseFieldValue(message, 'x'.repeat(ANNOUNCEMENT_MAX_LENGTH + 1))).toThrow(/at most 280/)
  expect(() => parseFieldValue(message, 'bell\u0007')).toThrow(/control/)
  expect(formatFieldValue(message, '<b>shown as text</b>')).toBe('<b>shown as text</b>')
})

test('the banner cannot be on without a message', () => {
  const fields = [live, message]
  const state = { 'snl.live': false, 'snl.message': '' }
  expect(() => validateChanges({ state, changes: [{ key: 'snl.live', value: 'true' }], fields })).toThrow(/needs a message/)
  expect(() => validateChanges({ state: { ...state, 'snl.live': true, 'snl.message': 'hi' }, changes: [{ key: 'snl.message', value: '   ' }], fields })).toThrow(/needs a message/)
  const { postState } = validateChanges({ state, changes: [{ key: 'snl.message', value: 'New feature: polls' }, { key: 'snl.live', value: 'true' }], fields })
  expect(postState).toMatchObject({ 'snl.live': true, 'snl.message': 'New feature: polls' })
})

test('the public announcement is the message only while the banner is on', async () => {
  const query = row => resolvers.Query.announcement(null, {}, { models: { snl: { findFirst: async () => row } } })
  expect(await query({ live: true, message: 'Polls are live' })).toBe('Polls are live')
  expect(await query({ live: false, message: 'Polls are live' })).toBeNull()
  expect(await query({ live: true, message: '' })).toBeNull()
  expect(await query(null)).toBeNull()
})
