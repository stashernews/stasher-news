/* eslint-env jest */
import { onPaid } from '@/api/payIn/index'

// `onPaid` lives in `api/payIn/index.js`, which imports the `api/payIn/types`
// barrel. The barrel pulls `itemCreate` -> `lib/lexical/server/mentions` ->
// the ESM-only `mdast-util-from-markdown`. next/jest does not transform that
// node_modules ESM, so the barrel must be mocked to load `onPaid`. Jest hoists
// jest.mock above the import, so the mock is registered before resolution.
// The path is relative because next/jest registers no `@/*` moduleNameMapper,
// so jest.mock (unlike import) cannot resolve the `@/` alias.
jest.mock('../../../../api/payIn/types', () => ({
  __esModule: true,
  default: { TERRITORY_CREATE: { onPaid: jest.fn(async () => {}) } }
}))

// The stripped custodial/Lightning relations must never appear in the Prisma
// include passed to tx.payIn.findUnique — Prisma throws "Unknown argument"
// on them, and the piconeros:0 fee path runs `onPaid` synchronously inside the
// begin transaction (index.js:90-91), so it must not throw.
const GHOST = ['payInCustodialTokens', 'payOutCustodialTokens', 'payInBolt11', 'payOutBolt11', 'pessimisticEnv']

describe('onPaid (ghost-neutralized)', () => {
  test('findUnique include contains no custodial/bolt/pessimistic relations', async () => {
    const findUnique = jest.fn(async ({ where }) => ({
      id: where.id,
      payInType: 'TERRITORY_CREATE',
      userId: 7,
      piconeros: 0n,
      payInState: 'PAID',
      beneficiaries: []
    }))
    const tx = {
      payIn: { findUnique },
      $executeRaw: jest.fn(async () => 1)
    }

    await onPaid(tx, 42)

    const include = findUnique.mock.calls[0][0].include
    for (const key of GHOST) {
      expect(include).not.toHaveProperty(key)
    }
    expect(include.beneficiaries).toBe(true)
  })
})
