#!/usr/bin/env node
// Verifies the editor length counter measures the markdown Formik submits in
// BOTH modes (the write-vs-compose counter disagreement, 2026-09-16): proves
// the exported markdown differs from rendered text content, and that
// remaining/clamping use the markdown length. Not a jest test because
// next/jest cannot load the ESM-only mdast stack (see
// test/engine/payInItemCreate.test.js).
//
// Usage (dev) — --tsconfig is required for the `@/` alias:
//   docker exec -w /app app npx tsx --tsconfig jsconfig.json scripts/check-markdown-length.js

import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical'
import { $createLinkNode, LinkNode } from '@lexical/link'
import { createHeadlessEditor } from '@lexical/headless'
import { getRemainingMarkdown, markdownLength } from '@/lib/lexical/utils'

const makeEditor = (namespace) => createHeadlessEditor({
  namespace,
  nodes: [LinkNode], // TextNode/ParagraphNode are core; LinkNode holds its URL in an attribute
  onError: (error) => { throw error }
})

// rich mode: markdown syntax (**) and the link URL do not exist in rendered text
const rich = makeEditor('sn-rich')
rich.update(() => {
  const paragraph = $createParagraphNode()
  paragraph.append($createTextNode('bold').setFormat('bold'))
  paragraph.append($createLinkNode('https://stasher.news/uploads/1').append($createTextNode('file')))
  $getRoot().append(paragraph)
}, { discrete: true })

// markdown mode: two paragraphs submit with a joining newline rendered text lacks
const markdown = makeEditor('sn-markdown')
markdown.update(() => {
  $getRoot().append($createParagraphNode().append($createTextNode('first line')))
  $getRoot().append($createParagraphNode().append($createTextNode('second line')))
}, { discrete: true })

const checks = []
const check = (name, ok) => checks.push([name, ok])

const richRendered = rich.getEditorState().read(() => $getRoot().getTextContentSize())
const richMarkdown = markdownLength(rich)
check('rich markdown length exceeds rendered text (the compose-tab undercount)', richMarkdown > richRendered)
check('rich remaining uses markdown length', getRemainingMarkdown(rich, 100) === 100 - richMarkdown)

const mdRendered = markdown.getEditorState().read(() => $getRoot().getTextContentSize())
const mdMarkdown = markdownLength(markdown)
const mdSubmitted = 'first line\nsecond line'
check('markdown mode counts the submitted string incl. paragraph newlines', mdMarkdown === mdSubmitted.length && mdMarkdown !== mdRendered)
check('markdown remaining uses markdown length', getRemainingMarkdown(markdown, 100) === 100 - mdMarkdown)

check('remaining clamps at 0 when over the limit', getRemainingMarkdown(rich, richMarkdown - 1) === 0)

for (const [name, ok] of checks) console.log(`${ok ? 'ok' : 'FAIL'} - ${name}`)
const failures = checks.filter(([, ok]) => !ok)
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
