/* eslint-env jest */
import stringifyCanon from 'canonical-json'
import { createHash } from 'crypto'
import { timestampItem } from '@/worker/ots'
import { Notary } from '../../lib/ots-mini/index.js'

// timestampItem chains a reply's OTS proof to its parent's otsHash. Decision
// rule under test (worker/ots.js):
//   - parent has a hash (deleted or not) -> chain to it
//   - parent hashless but its own timestampItem job is still pending
//     (created/retry/active) -> throw so pg-boss retries preserve
//     parent-before-child chaining (jobs queue in item-creation order,
//     itemCreate.onPaid); a freshly deleted parent still stamps its blanked
//     content via its own queued job
//   - parent hashless with no pending job (row missing, abandoned + jobs
//     cleared by abandonFeeItems, or its own job dead) -> can NEVER gain a
//     hash: stamp standalone instead of dead-lettering (throwing dead-letters
//     after 12 retries and fires the [CRITICAL] deadman in worker/index.js)
// The standalone preimage (parentHash: null) is exactly what the ots page and
// the preimage endpoint recompute for a hashless parent, so proofs stay
// verifiable.
//
// Notary.stamp is stubbed at the module boundary (it POSTs to external OTS
// calendars); the rest of lib/ots-mini is real, so detached-file construction
// and hash storage run for real. Apollo + prisma are injected and mocked.

jest.mock(`${process.cwd()}/lib/ots-mini/index.js`, () => ({
  ...jest.requireActual(`${process.cwd()}/lib/ots-mini/index.js`),
  Notary: { stamp: jest.fn().mockResolvedValue(undefined) }
}))

const REPLY_ID = 338456
const PARENT_ID = 338455
const PARENT_HASH = 'a'.repeat(64)
const reply = { id: REPLY_ID, parentId: PARENT_ID, title: null, text: 'reply body', url: null }

// Mirrors the preimage formula shared with pages/items/[id]/ots.js and
// pages/api/ots/preimage/[id].js — pins cross-surface verification consistency.
const expectedHash = ({ parentHash, title, text, url }) =>
  createHash('sha256').update(stringifyCanon({ parentHash, title, text, url })).digest('hex')

// pending: what a SELECT over pgboss.job returns for the parent's own
// timestampItem job ([] = no queued/running job).
function ctx ({ item, parent, pending = [] }) {
  return {
    data: { id: REPLY_ID },
    apollo: { query: jest.fn().mockResolvedValue({ data: { item } }) },
    models: {
      item: { findUnique: jest.fn().mockResolvedValue(parent), update: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue(pending)
    }
  }
}

beforeEach(() => { jest.clearAllMocks() })

test('deleted parent, jobs cleared: stamps standalone instead of dead-lettering', async () => {
  const c = ctx({ item: reply, parent: { otsHash: null, deletedAt: new Date('2026-09-01') }, pending: [] })

  await timestampItem(c)

  expect(c.models.item.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: PARENT_ID } }))
  expect(Notary.stamp).toHaveBeenCalledTimes(1)
  expect(c.models.item.update).toHaveBeenCalledWith({
    where: { id: REPLY_ID },
    data: { otsHash: expectedHash({ parentHash: null, title: null, text: 'reply body', url: null }), otsFile: expect.any(Buffer) }
  })
})

test('missing parent row: stamps standalone instead of dead-lettering', async () => {
  const c = ctx({ item: reply, parent: null, pending: [] })

  await timestampItem(c)

  expect(Notary.stamp).toHaveBeenCalledTimes(1)
  expect(c.models.item.update).toHaveBeenCalledWith({
    where: { id: REPLY_ID },
    data: { otsHash: expectedHash({ parentHash: null, title: null, text: 'reply body', url: null }), otsFile: expect.any(Buffer) }
  })
})

test('live parent with pending stamp job: still throws so stamp order is preserved', async () => {
  const c = ctx({ item: reply, parent: { otsHash: null, deletedAt: null }, pending: [{ '?column?': 1 }] })

  await expect(timestampItem(c)).rejects.toThrow('no parent hash available')

  expect(Notary.stamp).not.toHaveBeenCalled()
  expect(c.models.item.update).not.toHaveBeenCalled()
})

test('freshly deleted parent whose stamp job is still queued: retries instead of standalone', async () => {
  // the parent's own job will stamp its blanked content — the reply must
  // chain to that, so standalone-stamping now would break verification later
  const c = ctx({ item: reply, parent: { otsHash: null, deletedAt: new Date('2026-09-01') }, pending: [{ '?column?': 1 }] })

  await expect(timestampItem(c)).rejects.toThrow('no parent hash available')

  expect(Notary.stamp).not.toHaveBeenCalled()
  expect(c.models.item.update).not.toHaveBeenCalled()
})

test('stamped parent: chains the proof to the parent hash', async () => {
  const c = ctx({ item: reply, parent: { otsHash: PARENT_HASH, deletedAt: null } })

  await timestampItem(c)

  // short-circuit: no pending-job lookup needed when the hash already exists
  expect(c.models.$queryRaw).not.toHaveBeenCalled()
  expect(Notary.stamp).toHaveBeenCalledTimes(1)
  expect(c.models.item.update).toHaveBeenCalledWith({
    where: { id: REPLY_ID },
    data: { otsHash: expectedHash({ parentHash: PARENT_HASH, title: null, text: 'reply body', url: null }), otsFile: expect.any(Buffer) }
  })
})

test('item gone (deleted before its job ran): no-op', async () => {
  const c = ctx({ item: null })

  await timestampItem(c)

  expect(c.models.item.findUnique).not.toHaveBeenCalled()
  expect(c.models.$queryRaw).not.toHaveBeenCalled()
  expect(Notary.stamp).not.toHaveBeenCalled()
  expect(c.models.item.update).not.toHaveBeenCalled()
})
