import { gql } from 'graphql-tag'
import stringifyCanon from 'canonical-json'
import { createHash } from 'crypto'
import { DetachedTimestampFile, Notary, OpSHA256 } from '../lib/ots-mini/index.js'

const ITEM_OTS_FIELDS = gql`
  fragment ItemOTSFields on Item {
    parentId
    title
    text
    url
  }`

export async function timestampItem ({ data: { id }, apollo, models }) {
  const { data: { item } } = await apollo.query({
    query: gql`
        ${ITEM_OTS_FIELDS}
        query Item {
          item(id: ${id}) {
            ...ItemOTSFields
          }
        }`
  })

  // item was deleted (STOPPED) before it could be timestamped — nothing to do
  if (!item) return

  const { parentId, title, text, url } = item

  // Resolve the parent's hash from its raw row (visibility filters bypassed
  // on purpose — deleted parents must stay resolvable here). Decision rule:
  //   - parent has a hash (deleted or not) -> chain to it
  //   - hashless but its own timestampItem job is still pending -> throw so
  //     pg-boss retries preserve parent-before-child chaining (jobs queue in
  //     item-creation order, itemCreate.onPaid); a freshly deleted parent
  //     still stamps its blanked content via its own queued job
  //   - hashless with no pending job (row missing, abandoned + jobs cleared
  //     by abandonFeeItems, or its own job dead) -> it can never gain a hash:
  //     stamp standalone instead of dead-lettering. The standalone preimage
  //     (parentHash: null) is exactly what the ots page and preimage endpoint
  //     recompute for a hashless parent, so the proof stays verifiable.
  let parentOtsHash = null
  if (parentId) {
    const parent = await models.item.findUnique({
      where: { id: parentId },
      select: { otsHash: true, deletedAt: true }
    })

    if (parent?.otsHash) {
      parentOtsHash = parent.otsHash
    } else {
      const [pending] = await models.$queryRaw`
        SELECT 1 FROM pgboss.job
        WHERE name = 'timestampItem' AND data->>'id' = ${parentId}::TEXT
        AND state IN ('created', 'retry', 'active')
        LIMIT 1`
      if (pending) {
        throw new Error('no parent hash available ... retrying later')
      }
    }
  }

  let otsHash
  let detached
  try {
    // SHA256 hash item using a canonical serialization format { parentHash, title, text, url }
    const itemString = stringifyCanon({ parentHash: parentOtsHash, title, text, url })
    otsHash = createHash('sha256').update(itemString).digest()
    detached = DetachedTimestampFile.fromHash(new OpSHA256(), otsHash)
  } catch (e) {
    // if any of this errors out, it's non-recoverable: do not retry
    console.error('Fatal error while generating ots timestamp data:', e)
    return
  }

  // timestamp it
  await Notary.stamp(detached)

  // get proof
  const otsFile = Buffer.from(detached.serializeToBytes())

  // store in item
  await models.item.update({ where: { id }, data: { otsHash: otsHash.toString('hex'), otsFile } })
}
