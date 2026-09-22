/* eslint-env jest */
import resolvers from '@/api/resolvers/draft'

const me = { id: 42 }
const now = new Date()

function draftRow (over = {}) {
  return {
    id: 1,
    userId: 42,
    type: 'DISCUSSION',
    title: 't',
    text: 'hello',
    url: null,
    subName: 'meta',
    extra: null,
    moneroWallPricePiconeros: null,
    moneroWallThresholdPiconeros: null,
    createdAt: now,
    updatedAt: now,
    ...over
  }
}

// `mock` prefix is required — jest's hoister rejects other out-of-scope names
// inside a jest.mock factory.
const mockCaps = jest.fn(async () => [])
const mockSync = jest.fn(async () => {})

// relative specifier in jest.mock — the `@/` alias is only rewritten for
// import statements (repo-wide jest.mock convention)
jest.mock('../../lib/drafts', () => ({
  ...jest.requireActual('../../lib/drafts'),
  assertDraftCaps: (...args) => mockCaps(...args),
  syncDraftPins: (...args) => mockSync(...args)
}))

const modelsWith = (rows = []) => {
  const tx = {
    draft: {
      findUnique: jest.fn().mockResolvedValue(rows[0] ?? null),
      create: jest.fn().mockResolvedValue(rows[0]),
      update: jest.fn().mockResolvedValue(rows[0]),
      delete: jest.fn().mockResolvedValue({ id: 1 })
    },
    draftUpload: { deleteMany: jest.fn(), createMany: jest.fn() }
  }
  return {
    tx,
    draft: {
      findMany: jest.fn().mockResolvedValue(rows),
      findUnique: jest.fn().mockResolvedValue(rows[0] ?? null),
      create: jest.fn().mockResolvedValue(rows[0]),
      update: jest.fn().mockResolvedValue(rows[0]),
      delete: jest.fn().mockResolvedValue({ id: 1 })
    },
    // read by the Draft.pinnedMediaBytes field resolver
    draftUpload: { findMany: jest.fn().mockResolvedValue([{ upload: { size: 1024 } }, { upload: { size: 2048 } }]) },
    $transaction: jest.fn(async fn => fn(tx))
  }
}

describe('myDrafts', () => {
  test('returns the owner\'s drafts, rejects anonymous', async () => {
    const models = modelsWith([draftRow()])
    expect((await resolvers.Query.myDrafts({}, {}, { me, models })).length).toBe(1)
    await expect(resolvers.Query.myDrafts({}, {}, { me: null, models })).rejects.toThrow(/logged in/)
  })
})

describe('draft', () => {
  test('owner fetches it; anonymous errors; foreign or missing is null', async () => {
    const models = modelsWith([draftRow()])
    await expect(resolvers.Query.draft({}, { id: 1 }, { me, models })).resolves.toMatchObject({ id: 1, userId: 42 })
    await expect(resolvers.Query.draft({}, { id: 1 }, { me: null, models })).rejects.toThrow(/logged in/)
    const foreign = modelsWith([draftRow({ userId: 7 })])
    await expect(resolvers.Query.draft({}, { id: 1 }, { me, models: foreign })).resolves.toBeNull()
    const missing = modelsWith([])
    await expect(resolvers.Query.draft({}, { id: 999 }, { me, models: missing })).resolves.toBeNull()
  })
})

describe('upsertDraft', () => {
  test('creates a draft with derived pins', async () => {
    mockCaps.mockResolvedValueOnce([12, 34])
    const models = modelsWith([draftRow()])
    await resolvers.Mutation.upsertDraft({}, { input: { type: 'DISCUSSION', title: 't', text: 'x' } }, { me, models })
    expect(mockSync).toHaveBeenCalledWith(expect.anything(), 1, [12, 34])
  })

  test('update path requires ownership and refreshes pins', async () => {
    mockCaps.mockResolvedValueOnce([12])
    const models = modelsWith([draftRow()])
    await resolvers.Mutation.upsertDraft({}, { input: { id: 1, type: 'DISCUSSION', text: 'x' } }, { me, models })
    expect(mockSync).toHaveBeenCalledWith(expect.anything(), 1, [12])
    const foreign = modelsWith([draftRow({ userId: 7 })])
    await expect(resolvers.Mutation.upsertDraft({}, { input: { id: 1, type: 'DISCUSSION' } }, { me, models: foreign }))
      .rejects.toThrow(/not found/)
  })

  test('rejects text over MAX_POST_TEXT_LENGTH and unknown types', async () => {
    const models = modelsWith([draftRow()])
    await expect(resolvers.Mutation.upsertDraft({}, { input: { type: 'DISCUSSION', text: 'a'.repeat(100001) } }, { me, models }))
      .rejects.toThrow(/too long/)
    await expect(resolvers.Mutation.upsertDraft({}, { input: { type: 'NOPE' } }, { me, models }))
      .rejects.toThrow(/type/)
  })

  test('caps violations surface the helper error', async () => {
    mockCaps.mockRejectedValueOnce(new Error('draft limit reached (10) — delete one first'))
    const models = modelsWith([draftRow()])
    await expect(resolvers.Mutation.upsertDraft({}, { input: { type: 'DISCUSSION' } }, { me, models }))
      .rejects.toThrow(/draft limit/)
  })

  test('round-trips randPollOptions through the created extra', async () => {
    const models = modelsWith([draftRow()])
    await resolvers.Mutation.upsertDraft({}, { input: { type: 'POLL', pollOptions: ['yes', 'no'], randPollOptions: true } }, { me, models })
    const { data } = models.tx.draft.create.mock.calls[0][0]
    expect(data.extra).toEqual({ pollOptions: ['yes', 'no'], randPollOptions: true })
    // Draft.extra serializes the stored Json back to the client-facing string
    expect(JSON.parse(resolvers.Draft.extra(data))).toEqual(data.extra)
  })
})

describe('deleteDraft', () => {
  test('owner deletes; foreign draft reports false', async () => {
    const models = modelsWith([draftRow()])
    expect(await resolvers.Mutation.deleteDraft({}, { id: 1 }, { me, models })).toBe(true)
    const foreign = modelsWith([draftRow({ userId: 7 })])
    expect(await resolvers.Mutation.deleteDraft({}, { id: 1 }, { me, models: foreign })).toBe(false)
  })
})

describe('Draft field resolvers', () => {
  test('pinnedMediaBytes sums the draft\'s pinned upload sizes', async () => {
    const models = modelsWith([draftRow()])
    await expect(resolvers.Draft.pinnedMediaBytes(draftRow(), {}, { me, models })).resolves.toBe(3072n)
  })

  test('extra stringifies the stored Json; null stays null', () => {
    expect(resolvers.Draft.extra({ extra: { bountyPiconeros: '1000' } })).toBe('{"bountyPiconeros":"1000"}')
    expect(resolvers.Draft.extra({ extra: null })).toBeNull()
  })
})
