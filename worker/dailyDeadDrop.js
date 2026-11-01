import pay from '@/api/payIn'
import { DEAD_DROP_TITLE, USER_ID } from '@/lib/constants'

// The Daily Dead Drop: a site-wide discussion thread the deaddrop bot posts
// once a day (pgboss.schedule 'dailyDeadDrop', 00:00 UTC). Each thread carries
// no turf, so its subNames is NULL and the home feed injects it at the top as
// a global pin (api/resolvers/item.js); every day's thread shares one Pin row,
// and the feed shows only the newest item per pin.
//
// Self-bootstrapping: when no thread exists yet, the job creates the global
// Pin and posts day 1, so a fresh install needs no manual first post.

const DEAD_DROP_TEXT = `Today's Dead Drop. A spot where messages get left for pickup.

Anything goes: introduce yourself, drop links, ask questions, comment on recent events, share half-formed ideas, and whatever else doesn't need its own post.

A new drop goes up every day at 00:00 UTC.`

export function deadDropTitle (day) {
  return `${DEAD_DROP_TITLE}: day ${day}`
}

// day number parsed from a thread title; null when the title doesn't carry one
export function deadDropDay (title) {
  const match = /: day (\d+)$/.exec(title ?? '')
  return match ? Number(match[1]) : null
}

function startOfUtcDay (date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export async function dailyDeadDrop ({ models, pay: payFn = pay, now = new Date() }) {
  const latest = await models.item.findFirst({
    where: {
      userId: USER_ID.deadDrop,
      parentId: null,
      pinId: { not: null },
      title: { startsWith: `${DEAD_DROP_TITLE}: day ` }
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, pinId: true, createdAt: true }
  })

  // one drop per UTC day: a retried or duplicate run (cron plus the boot
  // seed in worker/index.js) is a no-op once today's thread exists
  if (latest && latest.createdAt >= startOfUtcDay(now)) {
    console.log('dailyDeadDrop: already posted today', latest.id)
    return { skipped: true, itemId: latest.id }
  }

  const day = (deadDropDay(latest?.title) ?? 0) + 1
  const newPin = !latest?.pinId
  const pinId = newPin ? await createGlobalPin(models) : latest.pinId

  let result
  try {
    ({ result } = await payFn('ITEM_CREATE', {
      title: deadDropTitle(day),
      text: DEAD_DROP_TEXT,
      userId: USER_ID.deadDrop,
      subNames: [],
      pinId
    }, {
      me: { id: USER_ID.deadDrop },
      custodialOnly: true
    }))
  } catch (e) {
    // the pin is created outside the payIn transaction: drop it so a failed
    // bootstrap attempt (and each retry) doesn't leave an empty Pin behind
    if (newPin) await models.pin.delete({ where: { id: pinId } }).catch(() => {})
    throw e
  }

  return { skipped: false, itemId: result?.id, day }
}

// a new global pin goes after the existing global pins (same position rule as
// the pinItem mutation, scoped to items with no turf)
async function createGlobalPin (models) {
  const [{ id }] = await models.$queryRaw`
    INSERT INTO "Pin" (position)
    SELECT COALESCE(MAX(p.position), 0) + 1
    FROM "Pin" p
    WHERE EXISTS (
      SELECT 1 FROM "Item" i
      WHERE i."pinId" = p.id AND i."parentId" IS NULL AND i."subNames" IS NULL)
    RETURNING id`
  return id
}
