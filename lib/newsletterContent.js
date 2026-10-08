import { readFile } from 'node:fs/promises'
import removeMd from 'remove-markdown'
import { indexableMoneroWallText } from '@/lib/monero-wall'

// Content gathering for the biweekly community roundup. Section structure
// ports upstream's scripts/newsletter.js (top posts, most-discussed,
// territory movement) to in-process queries — a broadcast cannot filter
// per-recipient, so there is deliberately NO per-user mute filtering here
// (unlike the digest); NSFW territories are excluded, same guard as
// getCommunityHighlights.

const TOP_POSTS_LIMIT = 8
const DISCUSSED_LIMIT = 5
const TERRITORY_LIMIT = 5
const EXCERPT_MAX = 160

// Short body preview for the top-posts section: the first sentence of the
// post (markdown stripped, whitespace collapsed), falling back to a truncation
// when the body has no sentence terminator. Monero-walled posts surface their
// wall text via indexableMoneroWallText (same as the digest) so a locked body
// is never leaked. Returns null when there is nothing to show.
export function postExcerpt (item, max = EXCERPT_MAX) {
  const raw = removeMd(indexableMoneroWallText(item) ?? '')
  const s = String(raw).replace(/\s+/g, ' ').trim()
  if (!s) return null
  const m = s.match(/^(.+?[.!?])(\s|$)/)
  let out = m ? m[1] : s
  if (out.length > max) out = `${out.slice(0, max - 1).trimEnd()}…`
  return out
}

// The operator's editorial slot: a markdown file rendered as the lead
// section. Absence is normal and skipped silently.
export async function readEditorial (path = process.env.NEWSLETTER_EDITORIAL_FILE || '/etc/stashernews/newsletter-editorial.md') {
  if (!path) return null
  try { return await readFile(path, 'utf8') } catch { return null }
}

export async function gatherNewsletterContent ({ models, from, to }) {
  const topPosts = await models.$queryRawUnsafe(
    `SELECT "Item".id, "Item".title, "Item".ncomments, "Item".piconeros, "Item"."subNames", "Item".text, "Item"."moneroWallEnabledAt", "Item"."moneroWallRemovedAt", u.name AS "userName"
     FROM "Item" JOIN users u ON u.id = "Item"."userId"
     WHERE "Item".created_at > $1 AND "Item".created_at <= $2
       AND "Item"."parentId" IS NULL AND "Item".title IS NOT NULL
       AND "Item"."deletedAt" IS NULL AND "Item".bio = false
       AND NOT EXISTS (SELECT 1 FROM "Sub" s WHERE s.name = ANY("Item"."subNames") AND s.nsfw)
     ORDER BY "Item".piconeros DESC, "Item".ranktop DESC
     LIMIT $3`, from, to, TOP_POSTS_LIMIT)

  const mostDiscussed = await models.$queryRawUnsafe(
    `SELECT "Item".id, "Item".title, "Item".ncomments, "Item".piconeros, "Item"."subNames", u.name AS "userName"
     FROM "Item" JOIN users u ON u.id = "Item"."userId"
     WHERE "Item".created_at > $1 AND "Item".created_at <= $2
       AND "Item"."parentId" IS NULL AND "Item".title IS NOT NULL
       AND "Item"."deletedAt" IS NULL AND "Item".bio = false
       AND NOT EXISTS (SELECT 1 FROM "Sub" s WHERE s.name = ANY("Item"."subNames") AND s.nsfw)
     ORDER BY "Item".ncomments DESC
     LIMIT $3`, from, to, DISCUSSED_LIMIT)

  const territoryMovement = await models.$queryRawUnsafe(
    `SELECT "Item"."subNames"[1] AS "subName", COUNT(*)::int AS posts, COALESCE(SUM("Item".piconeros), 0)::bigint AS "piconeros"
     FROM "Item"
     WHERE "Item".created_at > $1 AND "Item".created_at <= $2
       AND "Item"."parentId" IS NULL AND "Item"."deletedAt" IS NULL AND "Item".bio = false
       AND array_length("Item"."subNames", 1) > 0
       AND NOT EXISTS (SELECT 1 FROM "Sub" s WHERE s.name = ANY("Item"."subNames") AND s.nsfw)
     GROUP BY 1 ORDER BY SUM("Item".piconeros) DESC NULLS LAST LIMIT $3`,
    from, to, TERRITORY_LIMIT)

  const editorial = await readEditorial()
  return {
    topPosts: topPosts.map(p => ({ ...p, excerpt: postExcerpt(p) })),
    mostDiscussed,
    territoryMovement,
    ...(editorial ? { editorial } : {})
  }
}
