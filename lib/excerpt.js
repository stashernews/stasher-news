const MAX_EXCERPT_CHARS = 300

// Cheap markdown strip for feed-card teasers. Deliberately regex-based:
// the items listing resolver runs this per row per request, and mdast
// parsing of large bodies on the hot path is unacceptable. Good enough
// for a 2-line teaser; the full body is always one click away.
function stripMarkdown (text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks -> drop
    .replace(/`([^`]+)`/g, '$1 ') // inline code -> text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1 ') // images -> alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1 ') // links -> label
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/^\s*>\s?/gm, '') // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '') // list markers
    .replace(/^---+$/gm, ' ') // horizontal rules
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(\*|_)(.*?)\1/g, '$2') // italic
    .replace(/<[^>]+>/g, ' ') // html tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
}

export function makeExcerpt (text) {
  if (!text || !text.trim()) return null
  const plain = stripMarkdown(text).replace(/\s+/g, ' ').trim()
  if (!plain) return null
  if (plain.length <= MAX_EXCERPT_CHARS) return plain
  return plain.slice(0, MAX_EXCERPT_CHARS).replace(/\s\S*$/, '') + '…'
}
