/* eslint-env jest */
import { Prisma } from '@prisma/client'
import { FIELDS, EXCLUDED_COLUMNS, getFieldState } from '@/lib/admin/fields'
import { SECTIONS } from '@/lib/admin/sections'
import { parseFieldValue, formatFieldValue } from '@/lib/admin/units'

function uncoveredColumns (models) {
  return models.filter(model => ['PlatformFeeConfig', 'SiteSettings'].includes(model.name)).flatMap(model => {
    const store = model.name[0].toLowerCase() + model.name.slice(1)
    return model.fields.filter(column => !FIELDS.some(field => field.store === store && field.key === column.name) &&
      !EXCLUDED_COLUMNS[store].includes(column.name)).map(column => `${model.name}.${column.name}`)
  })
}

test('every editable Prisma column is registered or explicitly excluded', () => {
  expect(uncoveredColumns(Prisma.dmmf.datamodel.models)).toEqual([])
  expect(uncoveredColumns([{ name: 'SiteSettings', fields: [{ name: 'unregisteredFutureSetting' }] }])).toEqual(['SiteSettings.unregisteredFutureSetting'])
  expect(new Set(FIELDS.map(field => field.key)).size).toBe(FIELDS.length)
})

test('registry sections, bounds and units support form generation and exact round trips', () => {
  expect(SECTIONS.map(section => section.id)).toEqual(['overview', 'fees', 'trust', 'rewards', 'content', 'site', 'access', 'environment', 'audit'])
  for (const field of FIELDS) {
    const section = SECTIONS.find(section => section.id === field.section)
    expect(section.groups).toContain(field.group)
    expect(field.label).toBeTruthy()
    expect(field.help).toBeTruthy()
    expect(field.takesEffect).toBeTruthy()
    for (const bound of [field.min, field.max].filter(value => value !== undefined)) {
      expect(formatFieldValue(field, parseFieldValue(field, bound))).toBe(bound)
    }
  }
  expect(FIELDS.filter(field => field.rolloutMode).map(field => field.key)).toEqual(['curatorBudgetMode'])
})

test('future fields can declare locks and effective-value rules without page code', () => {
  const field = { key: 'mode', lockedWhen: { key: 'automation', equals: true, reason: 'automated' }, effectiveWhen: { key: 'budget', notEquals: 'ACTIVE', value: 'SHADOW', reason: 'budget inactive' } }
  expect(getFieldState(field, { mode: 'ACTIVE', automation: true, budget: 'SHADOW' })).toMatchObject({ locked: true, lockReason: 'automated', effectiveValue: 'SHADOW', effectiveReason: 'budget inactive' })
  expect(getFieldState(field, { mode: 'OFF', automation: false, budget: 'ACTIVE' })).toMatchObject({ locked: false, effectiveValue: 'OFF' })
})
