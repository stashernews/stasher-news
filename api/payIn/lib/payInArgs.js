// PayIn args are persisted verbatim for deferred ITEM_UPDATE edits
// (PendingItemUpdate.args). They can contain BigInt values (GraphQL BigInt
// scalars, e.g. bountyPiconeros) that JSON / Prisma Json cannot serialise, so
// BigInts are tagged as { $bigint: '<decimal>' } and revived on read.

const BIGINT_TAG = '$bigint'

function tagBigInt (key, value) {
  return typeof value === 'bigint' ? { [BIGINT_TAG]: value.toString() } : value
}

function reviveBigInt (key, value) {
  if (value && typeof value === 'object' && typeof value[BIGINT_TAG] === 'string') {
    return BigInt(value[BIGINT_TAG])
  }
  return value
}

export function serializePayInArgs (args) {
  return JSON.parse(JSON.stringify(args, tagBigInt))
}

export function deserializePayInArgs (stored) {
  return JSON.parse(JSON.stringify(stored), reviveBigInt)
}
