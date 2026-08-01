const nextJest = require('next/jest')

// Providing the path to your Next.js app which will enable loading next.config.js and .env files
const createJestConfig = nextJest({ dir: './' })

// createJestConfig is exported in this way to ensure that next/jest can load the Next.js configuration, which is async
// NOTE: SN legacy ignored a top-level `/payIn/` integration-test dir that does not
// exist in this fork. That broad pattern silently swallowed `test/api/payIn/**`,
// so it is removed — payIn-type unit tests now run in the default suite.
module.exports = createJestConfig({})
