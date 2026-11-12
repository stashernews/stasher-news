// CJS stand-in for the ESM-only @auth/prisma-adapter (type:module) inside
// jest's sandbox, which cannot require ESM (same problem as the uuid shim:
// see test/helpers/uuid-shim.js and jest.config.js). Nothing exercises the
// adapter itself in tests — suites that build NextAuth options only touch
// other callbacks (e.g. the auth redirect allowlist suite) — so a minimal
// adapter factory satisfies the import without reaching Prisma.
module.exports = {
  PrismaAdapter: () => ({})
}
