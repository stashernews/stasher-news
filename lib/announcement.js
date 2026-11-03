// Split an announcement into text and link parts. Only http(s) URLs become
// links; trailing sentence punctuation stays text ("see https://x.y/z.").
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi
const TRAILING = /[.,;:!?)\]}'"]+$/

export function announcementParts (message) {
  const parts = []
  let last = 0
  for (const match of String(message ?? '').matchAll(URL_PATTERN)) {
    const href = match[0].replace(TRAILING, '')
    if (match.index > last) parts.push({ text: message.slice(last, match.index) })
    parts.push({ href, text: href })
    last = match.index + href.length
  }
  if (last < String(message ?? '').length) parts.push({ text: message.slice(last) })
  return parts
}
