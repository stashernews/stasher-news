/* eslint-env jest */
import resolvers from '@/api/resolvers/item'

// api/resolvers/item.js drags in heavy ESM-only transitive deps; the mocks
// below break that chain — same pattern as test/api/resolvers/item-*.test.js.
jest.mock('../../components/editor', () => ({
  __esModule: true,
  SNEditor: 'textarea'
}))

jest.mock('../../api/payIn', () => ({
  __esModule: true,
  default: {}
}))

jest.mock('../../lib/lexical/server/html', () => ({
  __esModule: true,
  lexicalHTMLGenerator: async () => ''
}))

const enabledAt = new Date('2026-09-18T00:00:00Z')
const lockedItem = {
  id: 1,
  userId: 7,
  text: 'public intro\n[monerowall]\nsecret body',
  moneroWallPricePiconeros: 1_000_000_000n,
  moneroWallThresholdPiconeros: 5_000_000_000n,
  moneroWallEnabledAt: enabledAt
}
const unlockedItem = {
  ...lockedItem,
  moneroWallThresholdPiconeros: 1_000_000_000n
}
const fakeLoader = state => ({ load: async () => state })
const lockedState = { progressPiconeros: 2_000_000_000n, myContributionPiconeros: 0n, frozen: true }
const entitledState = { progressPiconeros: 2_000_000_000n, myContributionPiconeros: 1_000_000_000n, frozen: true }
const publicState = { progressPiconeros: 5_000_000_000n, myContributionPiconeros: 0n, frozen: true }

test('text: locked viewer gets the teaser only', async () => {
  const text = await resolvers.Item.text(lockedItem, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState) })
  expect(text).toBe('public intro')
})

test('text: entitled viewer gets full text without the marker', async () => {
  const text = await resolvers.Item.text(lockedItem, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(entitledState) })
  expect(text).toBe('public intro\n\nsecret body')
})

test('text: author gets raw text with the marker for editing', async () => {
  const text = await resolvers.Item.text(lockedItem, {}, { me: { id: 7 }, moneroWallLoader: fakeLoader(lockedState) })
  expect(text).toBe('public intro\n[monerowall]\nsecret body')
})

test('text: publicly unlocked item serves full text to anonymous viewers', async () => {
  const text = await resolvers.Item.text(unlockedItem, {}, { me: null, moneroWallLoader: fakeLoader(publicState) })
  expect(text).toBe('public intro\n\nsecret body')
})

test('excerpt: teaser-based while locked', async () => {
  const excerpt = await resolvers.Item.excerpt(lockedItem, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState) })
  expect(excerpt).toBe('public intro')
})

test('excerpt: full once publicly unlocked', async () => {
  const excerpt = await resolvers.Item.excerpt(unlockedItem, {}, { me: null, moneroWallLoader: fakeLoader(publicState) })
  expect(excerpt).toContain('secret body')
})

test('moneroWall: returns the view for walled items and null otherwise', async () => {
  const view = await resolvers.Item.moneroWall(lockedItem, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState) })
  expect(view.locked).toBe(true)
  expect(view.remainingPiconeros).toBe(3_000_000_000n)
  expect(await resolvers.Item.moneroWall({ ...lockedItem, moneroWallEnabledAt: null }, {}, { me: null, moneroWallLoader: fakeLoader(lockedState) })).toBe(null)
})

test('moneroWall + text: a removed wall is inert — null view, full text for everyone', async () => {
  const removed = { ...lockedItem, moneroWallRemovedAt: new Date('2026-09-20T00:00:00Z') }
  expect(await resolvers.Item.moneroWall(removed, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState) })).toBe(null)
  const text = await resolvers.Item.text(removed, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState) })
  expect(text).toBe('public intro\n\nsecret body')
})

const capturingLexicalLoader = () => {
  const calls = []
  return { calls, load: async arg => { calls.push(arg); return {} } }
}

test('html: locked viewer — lexical loader receives only the teaser', async () => {
  const loader = capturingLexicalLoader()
  await resolvers.Item.html(lockedItem, {}, { me: { id: 99 }, moneroWallLoader: fakeLoader(lockedState), lexicalStateLoader: loader })
  expect(loader.calls).toHaveLength(1)
  expect(loader.calls[0].text).toBe('public intro')
  expect(loader.calls[0].text).not.toContain('secret body')
})

test('lexicalState: author — lexical loader receives marker-stripped full text', async () => {
  const loader = capturingLexicalLoader()
  await resolvers.Item.lexicalState(lockedItem, {}, { me: { id: 7 }, moneroWallLoader: fakeLoader(lockedState), lexicalStateLoader: loader })
  expect(loader.calls).toHaveLength(1)
  expect(loader.calls[0].text).toBe('public intro\n\nsecret body')
})

test('lexicalState: non-walled item — lexical loader receives text unchanged', async () => {
  const plain = { ...lockedItem, text: 'raw body', moneroWallEnabledAt: null, moneroWallRemovedAt: null }
  const loader = capturingLexicalLoader()
  await resolvers.Item.lexicalState(plain, {}, { me: null, moneroWallLoader: fakeLoader(lockedState), lexicalStateLoader: loader })
  expect(loader.calls).toHaveLength(1)
  expect(loader.calls[0].text).toBe('raw body')
})
