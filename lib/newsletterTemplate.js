import { piconerosToXmr } from './format.js'

// Pure renderer for the biweekly community roundup. No DB, no network: the
// campaign worker and local previews call this with gathered sections. Email
// clients get a system font stack and text-only links, mirroring the digest
// template. The unsubscribe footer uses Resend's native per-recipient merge
// tag — a Broadcast is one HTML for the whole segment, so a per-user signed
// link (like the digest's) cannot be pre-rendered; Resend hosts the
// preference page and the contact.updated webhook mirrors it locally.

const MAX_RENDER = 25

// Amounts arrive as BigInt (int8 columns) but SUM() can come back as numeric
// (Prisma Decimal/string) — coerce defensively so a preview/send never dies on
// a formatting type mismatch.
function xmr (value) {
  try { return piconerosToXmr(typeof value === 'bigint' ? value : BigInt(value ?? 0)) } catch { return piconerosToXmr(0n) }
}

function escapeHtml (s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

function formatDate (d) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

// Tiny markdown subset for the operator's editorial slot: **bold**, *italic*,
// [text](url) links, blank-line paragraphs. Escaped first, so the source file
// cannot inject HTML into the broadcast.
function editorialHtml (md) {
  const inline = s => s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
  return String(md).trim().split(/\n{2,}/)
    .map(p => `<p style="margin: 0 0 10px;">${inline(escapeHtml(p)).replace(/\n/g, '<br/>')}</p>`)
    .join('')
}

function editorialText (md) {
  return String(md).trim()
}

export function renderNewsletter ({ sections = {}, windowStart, windowEnd, siteUrl = process.env.NEXT_PUBLIC_URL }) {
  const { topPosts = [], mostDiscussed = [], territoryMovement = [], editorial } = sections
  const items = arr => (Array.isArray(arr) ? arr.slice(0, MAX_RENDER) : [])

  const topPostsUrl = `${siteUrl}/top/posts/week`

  const postLine = (i, n) => {
    const meta = `${xmr(i.piconeros)} · ${i.ncomments ?? 0} comments · @${i.userName}${i.subNames?.[0] ? ` · ~${i.subNames[0]}` : ''}: ${siteUrl}/items/${i.id}`
    // title, then the excerpt, then the meta line
    return i.excerpt
      ? `${n}. ${i.title}\n   ${i.excerpt}\n   ${meta}`
      : `${n}. ${i.title} — ${meta}`
  }
  const postHtml = (i) => {
    const sub = i.subNames?.[0] ? ` · ~${escapeHtml(i.subNames[0])}` : ''
    const excerpt = i.excerpt ? `<br/><span style="color: #555;">${escapeHtml(i.excerpt)}</span>` : ''
    const meta = `<span style="color: #555;">${escapeHtml(xmr(i.piconeros))} · ${i.ncomments ?? 0} comments · @${escapeHtml(i.userName)}${sub}</span>`
    return `<li style="margin: 0 0 8px;"><a href="${siteUrl}/items/${i.id}" style="color: #1a1a1a;">${escapeHtml(i.title)}</a>${excerpt}<br/>${meta}</li>`
  }

  const top = items(topPosts)
  const discussed = items(mostDiscussed)
  const territories = items(territoryMovement)

  const topText = top.map((i, n) => postLine(i, n + 1))
  const discussedText = discussed.map(i => `- ${i.title} (${i.ncomments ?? 0} comments): ${siteUrl}/items/${i.id}`)
  const territoryText = territories.map(t => `- ~${t.subName}: ${t.posts} posts · ${xmr(t.piconeros)} upvoted`)

  const text = [
    'stasher news community roundup',
    `${formatDate(windowStart)} – ${formatDate(windowEnd)}`,
    '',
    ...(editorial ? [editorialText(editorial), ''] : []),
    ...(topText.length ? ['TOP POSTS:', ...topText, '', `all of this week's top posts: ${topPostsUrl}`, ''] : []),
    ...(discussedText.length ? ['MOST DISCUSSED:', ...discussedText, ''] : []),
    ...(territoryText.length ? ['TURF MOVEMENT:', ...territoryText, ''] : []),
    "you're getting this because a verified email is linked to your stasher news account.",
    'unsubscribe from the newsletter (the weekly digest is a separate setting): {{{RESEND_UNSUBSCRIBE_URL}}}',
    `manage everything in settings: ${siteUrl}/settings`
  ].join('\n')

  const sectionHtml = (title, lis) => `
    <h3 style="margin: 24px 0 8px; font-size: 16px; font-weight: 700;">${escapeHtml(title)}</h3>
    <ul style="margin: 0; padding-left: 18px; list-style: none;">${lis.join('')}</ul>`

  const html = `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 16px;">
  <h2 style="margin: 0 0 4px; font-size: 18px;">stasher news — community roundup</h2>
  <p style="margin: 0; color: #555;">${escapeHtml(formatDate(windowStart))} – ${escapeHtml(formatDate(windowEnd))}</p>
  ${editorial ? `<div style="margin: 16px 0; padding: 12px; background: #f5f5f5; border-radius: 8px;">${editorialHtml(editorial)}</div>` : ''}
  ${top.length ? sectionHtml('top posts', top.map(postHtml)) + `<p style="margin: 6px 0 0;"><a href="${topPostsUrl}" style="color: #1a1a1a;">all of this week's top posts</a></p>` : ''}
  ${discussed.length ? sectionHtml('most discussed', discussed.map(i => `<li style="margin: 0 0 8px;"><a href="${siteUrl}/items/${i.id}" style="color: #1a1a1a;">${escapeHtml(i.title)}</a> <span style="color: #555;">(${i.ncomments ?? 0} comments)</span></li>`)) : ''}
  ${territories.length ? sectionHtml('turf movement', territories.map(t => `<li style="margin: 0 0 8px;">~${escapeHtml(t.subName)} — ${t.posts} posts · ${escapeHtml(xmr(t.piconeros))} upvoted</li>`)) : ''}
  <p style="margin: 24px 0 6px; color: #555;">you're getting this because a verified email is linked to your stasher news account.</p>
  <p style="margin: 0; color: #555;"><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">unsubscribe from the newsletter</a> — the weekly digest is a separate setting.</p>
  <p style="margin: 0; color: #555;"><a href="${siteUrl}/settings">manage everything in settings</a></p>
</body></html>`

  return {
    subject: `stasher news roundup — ${formatDate(windowEnd)}`,
    text,
    html
  }
}
