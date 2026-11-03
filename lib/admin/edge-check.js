// "HealthSnapshot" timestamps are TIMESTAMP WITHOUT TIME ZONE read back as
// UTC by Prisma, so writes must bind the UTC wall-clock explicitly. Binding a
// Date lets the database session timezone reinterpret the instant (a non-UTC
// session shifts the stored value); a naive ISO string is stored verbatim.
const naiveUtc = date => date.toISOString().slice(0, 23)

export async function recordAdminEdge (models, ok, checkedAt = new Date()) {
  if (typeof ok !== 'boolean' || !(checkedAt instanceof Date) || Number.isNaN(+checkedAt)) throw new Error('invalid edge result')
  // Do not refresh updatedAt: that clock belongs to daemon/chain observations.
  // A row born from an edge check has no fresh chain-health observation yet.
  await models.$executeRaw`
    INSERT INTO "HealthSnapshot" (id, "adminEdgeOk", "adminEdgeCheckedAt", "updatedAt")
    VALUES (1, ${ok}, ${naiveUtc(checkedAt)}::timestamp(3), ${naiveUtc(new Date(0))}::timestamp(3))
    ON CONFLICT (id) DO UPDATE SET
      "adminEdgeOk" = EXCLUDED."adminEdgeOk",
      "adminEdgeCheckedAt" = EXCLUDED."adminEdgeCheckedAt"`
}
