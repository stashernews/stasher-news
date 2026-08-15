// uuid@14 is ESM-only (exports.node -> dist-node/index.js, no CJS entry),
// and next-auth v4 CJS-requires uuid inside jest's sandbox, which cannot
// require ESM (ERR_REQUIRE_ESM — the long-intermittent bountyFunding suite
// failure). Nothing in first-party code imports uuid directly, so jest
// moduleNameMapper redirects every require('uuid') here. next-auth/jwt uses
// only v4 (destructured at next-auth/jwt/index.js:17).
const { randomUUID } = require('node:crypto')

module.exports = { v4: () => randomUUID() }
