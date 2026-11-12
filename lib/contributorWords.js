// Contributor pool — effective word count.
//
// Source decision: `Item.text` is the canonical markdown. There is no stored
// Lexical state; `lexicalState` is derived on read from `text`
// (api/resolvers/item.js, lib/lexical/server/loader.js), so this counts `text`
// directly and needs no Lexical path. Addendum text is never passed in.
//
// Original prose only: blockquotes, URLs, images, link targets, HTML/embed
// tags and markdown syntax count zero; fenced code counts half; a repeated
// sentence or paragraph counts once; own uploads add a flat word bonus.
// Pure and inert: no Prisma, no logger.

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })

// A post is at most 100k characters (MAX_POST_TEXT_LENGTH); anything beyond
// twice that is not counted.
const MAX_TEXT_CHARS = 200_000

export const WORDS_PER_IMAGE = 100
export const MAX_IMAGES = 3

export function countWords (s) {
  let n = 0
  for (const seg of segmenter.segment(s)) if (seg.isWordLike) n++
  return n
}

export function effectiveWords (text, ownUploads = 0, { wordsPerImage = WORDS_PER_IMAGE, maxImages = MAX_IMAGES } = {}) {
  // Bounded input and bounded, single-line patterns: unclosed `![`, `[` or `<`
  // must not make the regexes quadratic (this runs inside the weekly ledger
  // transaction for every eligible candidate, tipped or not).
  const src = String(text || '').slice(0, MAX_TEXT_CHARS).replace(/\r\n?/g, '\n')
  const codeParts = []
  const noFences = src.replace(/(^|\n)(```|~~~)[^\n]*\n([\s\S]*?)(\n\2[^\n]*|$)/g, (_m, lead, _f, body) => {
    codeParts.push(body)
    return lead + '\n'
  })
  const prose = noFences
    .split('\n')
    .filter(line => !/^\s{0,3}>/.test(line)) // blockquotes
    .join('\n')
    .replace(/!\[[^\]\n]{0,1000}\]\([^)\n]{0,2000}\)/g, ' ') // images
    .replace(/\[([^\]\n]{0,1000})\]\([^)\n]{0,2000}\)/g, '$1') // links keep their text
    .replace(/<[^<>\n]{1,2000}>/g, ' ') // html / autolinks
    .replace(/\b(?:https?|ftp):\/\/\S+/gi, ' ') // bare urls
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/[#*_~`|>]/g, ' ')

  const seen = new Set()
  let proseWords = 0
  let duplicateUnits = 0
  for (const unit of prose.split(/\n+|(?<=[.!?。！？])\s+/)) {
    const norm = unit.toLowerCase().replace(/\s+/g, ' ').trim()
    if (!norm) continue
    const w = countWords(norm)
    if (w === 0) continue
    if (seen.has(norm)) { duplicateUnits++; continue }
    seen.add(norm)
    proseWords += w
  }
  const codeWords = codeParts.reduce((acc, c) => acc + countWords(c), 0)
  const imageWords = Math.min(Math.max(0, ownUploads), maxImages) * wordsPerImage
  return {
    words: proseWords + codeWords / 2 + imageWords,
    proseWords,
    codeWords,
    imageWords,
    duplicateUnits
  }
}
