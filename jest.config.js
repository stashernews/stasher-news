const nextJest = require('next/jest')

// Providing the path to your Next.js app which will enable loading next.config.js and .env files
const createJestConfig = nextJest({ dir: './' })

// createJestConfig is exported in this way to ensure that next/jest can load the Next.js configuration, which is async
// NOTE: SN legacy ignored a top-level `/payIn/` integration-test dir that does not
// exist in this fork. That broad pattern silently swallowed `test/api/payIn/**`,
// so it is removed — payIn-type unit tests now run in the default suite.
// The stagenet E2E suite under `test/integration/` is opt-in via
// RUN_STAGENET_INTEGRATION=1; by default those files are not even collected.
// The webhook load test under `test/load/` needs the LIVE compose stack (it
// POSTs to http://app:3000 and consumes real PENDING tips from the DB) —
// opt-in via RUN_WEBHOOK_LOAD=1, mirroring the stagenet gate.
module.exports = createJestConfig({
  testPathIgnorePatterns: process.env.RUN_STAGENET_INTEGRATION === '1'
    ? []
    : process.env.RUN_WEBHOOK_LOAD === '1'
      ? ['<rootDir>/test/integration/']
      : ['<rootDir>/test/integration/', '<rootDir>/test/load/'],
  // uuid@14 is ESM-only; next-auth v4 CJS-requires it inside jest's sandbox
  // (ERR_REQUIRE_ESM). No first-party code imports uuid, so redirect every
  // require('uuid') to a CJS shim. See test/helpers/uuid-shim.js.
  moduleNameMapper: {
    '^uuid$': '<rootDir>/test/helpers/uuid-shim.js'
  },
  // The real-DB integration suites (rewardsDistributor, curatorShares, paySub,
  // bountyFunding/Lifecycle, confirmFinalizer, ...) assume they are the SOLE
  // writer against the live dev DB (global count assertions like
  // payIn.count(), deterministic fixture addresses/hashes that collide across
  // suites). Jest's default parallel workers run them concurrently, producing
  // rotating 1-2-suite flakes on every full run (each suite green in
  // isolation). Serialize: ~46s total vs ~10s flaky.
  maxWorkers: 1
})
