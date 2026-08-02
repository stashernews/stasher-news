/* eslint-env jest */
import { PAY_IN_INCLUDE } from '@/api/payIn/lib/payInCreate'

// `payInCreate` transitively imports the `api/payIn/types` barrel (via ./is),
// which pulls `itemCreate` -> `lib/lexical/server/mentions` -> the ESM-only
// `mdast-util-from-markdown`. next/jest does not transform that node_modules
// ESM, so the barrel must be mocked to load `PAY_IN_INCLUDE`. Jest hoists
// jest.mock above the import, so the mock is registered before resolution.
// The path is relative because next/jest registers no `@/*` moduleNameMapper,
// so jest.mock (unlike import) cannot resolve the `@/` alias.
// `PAY_IN_INCLUDE` itself never touches the types barrel, so this is safe.
jest.mock('../../../../api/payIn/types', () => ({ __esModule: true, default: {} }))

// The stripped custodial/Lightning relations must never appear in the Prisma
// include passed to tx.payIn.create — Prisma throws "Unknown argument" on them.
const GHOST = ['payInCustodialTokens', 'payOutCustodialTokens', 'payInBolt11', 'payOutBolt11', 'pessimisticEnv']

describe('PAY_IN_INCLUDE', () => {
  test('contains no custodial / bolt / pessimistic relations', () => {
    for (const key of GHOST) {
      expect(PAY_IN_INCLUDE).not.toHaveProperty(key)
    }
  })

  test('still includes the real relations joined by the engine', () => {
    expect(PAY_IN_INCLUDE.beneficiaries).toBe(true)
  })
})
