import models from '@/api/models'
import { USER_ID } from '@/lib/constants'

export async function getServerSideProps () {
  // get the latest Daily Dead Drop (worker/dailyDeadDrop.js)
  const items = await models.$queryRaw`
    SELECT "Item".id as id
    FROM "Item"
    JOIN "ItemPayIn" ON "ItemPayIn"."itemId" = "Item".id
    JOIN "PayIn" ON "PayIn".id = "ItemPayIn"."payInId" AND "PayIn"."payInType" = 'ITEM_CREATE'
    WHERE "PayIn"."payInState" = 'PAID'
    AND "Item"."pinId" IS NOT NULL
    AND "Item"."userId" = ${USER_ID.deadDrop}::INTEGER
    AND "Item"."parentId" IS NULL
    ORDER BY "Item"."created_at" DESC
    LIMIT 1`

  const destination = items.length > 0 ? `/items/${items[0].id}` : '/'
  return { redirect: { destination, permanent: false } }
}

export default () => null
