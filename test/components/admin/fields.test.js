/* eslint-env jest */
import { renderToStaticMarkup } from 'react-dom/server'
import { FieldRow } from '@/components/admin/field-row'
import { reconcileDrafts, pendingChanges } from '@/components/admin/drafts'
import { PendingBar } from '@/components/admin/panel'

const field = { key: 'fee', label: 'Fee', type: 'xmr', value: '0.001', min: '0.0001', max: '0.1', help: 'A fee', takesEffect: 'cache', source: 'db', effectiveValue: '0.001' }

test.each(['xmr', 'int', 'float', 'pct', 'bps', 'enum', 'idList', 'bool', 'nullableBool'])('field type %s renders labeled controls and its live value', type => {
  const values = { bool: 'false', nullableBool: 'null', enum: 'LEGACY', idList: '1,2' }
  const html = renderToStaticMarkup(<FieldRow field={{ ...field, type, value: values[type] ?? '1', options: ['LEGACY', 'SHADOW', 'ACTIVE'] }} onChange={() => {}} onRevert={() => {}} />)
  expect(html).toContain('Fee')
  expect(html).toContain('Live')
  expect(html).toContain('field-fee')
  if (type === 'xmr') expect(html).toContain('XMR')
  if (type === 'bps') expect(html).toContain('×')
  if (type === 'nullableBool') expect(html).toContain('Reset to env')
  if (['bool', 'nullableBool', 'enum'].includes(type)) expect(html).toContain('aria-pressed')
})

test('locked fields display the reason, modified fields offer revert and invalid edits show an error', () => {
  const locked = renderToStaticMarkup(<FieldRow field={{ ...field, locked: true, lockReason: 'Automation owns this field' }} onChange={() => {}} />)
  expect(locked).toContain('disabled')
  expect(locked).toContain('Automation owns this field')
  const invalid = renderToStaticMarkup(<FieldRow field={field} draft={{ expected: '0.001', value: '1e-3' }} onChange={() => {}} onRevert={() => {}} />)
  expect(invalid).toContain('Modified')
  expect(invalid).toContain('Revert')
  expect(invalid).toContain('aria-invalid="true"')
})

test('stale reload discards only conflicting edits and keeps other changes with their original expected values', () => {
  const drafts = { fee: { expected: '0.001', value: '0.002' }, limit: { expected: '5', value: '6' } }
  const next = reconcileDrafts(drafts, ['fee'])
  expect(next).toEqual({ limit: { expected: '5', value: '6' } })
  expect(pendingChanges([{ ...field }], { fee: { expected: '0.001', value: '0.02' } })[0]).toMatchObject({ jump: true, error: null })
})

test('client staging catches cross-field mistakes before enabling review', () => {
  const fields = [
    { key: 'spamEscalationNumerator', type: 'int', value: '3', min: '1', max: '2147483647' },
    { key: 'spamEscalationDenominator', type: 'int', value: '2', min: '1', max: '2147483647' }
  ]
  const changes = pendingChanges(fields, { spamEscalationNumerator: { expected: '3', value: '8' } })
  expect(changes[0].error).toMatch(/between 1 and 3/)
})

test('the pending bar explains the server change cap and names cross-field errors before review', () => {
  const html = renderToStaticMarkup(<PendingBar changes={Array.from({ length: 51 }, () => ({}))} invalid={1} errors={['spam escalation factor must be between 1 and 3']} onDiscard={() => {}} onReview={() => {}} />)
  expect(html).toContain('at most 50')
  expect(html).toContain('spam escalation factor must be between 1 and 3')
  expect(html).toContain('disabled')
})
