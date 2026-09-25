/* eslint-env jest */

import { createHeadlessEditor } from '@lexical/headless'
import { $generateNodesFromDOM } from '@lexical/html'
import { AutoLinkNode, LinkNode } from '@lexical/link'
import { $getRoot, $createParagraphNode, $createTextNode, $insertNodes } from 'lexical'
import domino from 'domino'
import { SNLinkImportExtension } from '@/lib/lexical/exts/link-import'

// mirrors how the editor/bridge register the override via the extension
// config's html.import (appended after node importDOM entries, wins ties)
const htmlImport = SNLinkImportExtension.html.import

function buildEditor () {
  return createHeadlessEditor({
    namespace: 'sn-link-import-test',
    nodes: [AutoLinkNode, LinkNode],
    html: { import: htmlImport },
    onError: (e) => { throw e }
  })
}

function importHtml (editor, html, prefix = '') {
  const doc = domino.createWindow(html).document
  editor.update(() => {
    const root = $getRoot()
    root.clear()
    root.append($createParagraphNode())
    if (prefix) {
      root.getLastChild().append($createTextNode(prefix))
    }
    $insertNodes($generateNodesFromDOM(editor, doc))
  }, { discrete: true })
}

function linkUrls (editor) {
  const urls = []
  JSON.stringify(editor.getEditorState().toJSON(), (key, value) => {
    if (key === 'url') urls.push(value)
    return value
  })
  return urls
}

describe('SNLinkImportExtension', () => {
  it('uses the anchor text URL when the href is root-relative (x.com paste)', () => {
    // production bug: items 338968, 339643, 339760 stored
    // [https://x.com/<handle>/status/<id>](/<handle>/status/<id>) which
    // resolved against stasher.news and 404'd
    const editor = buildEditor()
    importHtml(
      editor,
      '<a href="/xmragora/status/2102472504287842710">https://x.com/xmragora/status/2102472504287842710</a>',
      'Just tweeted it: '
    )
    expect(linkUrls(editor)).toContain('https://x.com/xmragora/status/2102472504287842710')
  })

  it('keeps absolute hrefs verbatim', () => {
    const editor = buildEditor()
    importHtml(editor, '<a href="https://x.com/h/status/1?s=20">https://x.com/h/status/1</a>')
    expect(linkUrls(editor)).toContain('https://x.com/h/status/1?s=20')
  })

  it('keeps in-page fragment hrefs as-is', () => {
    const editor = buildEditor()
    importHtml(editor, '<a href="#section">jump</a>')
    expect(linkUrls(editor)).toContain('#section')
  })

  it('keeps relative hrefs whose text is not a URL (legit internal links)', () => {
    const editor = buildEditor()
    importHtml(editor, '<a href="/uploads/5">my upload</a>')
    expect(linkUrls(editor)).toContain('/uploads/5')
  })

  it('defers to guarded conversions for serialized anchors (returns null)', () => {
    const anchor = domino.createWindow('<a data-lexical-footnote-backref="1" href="#fn-1">back</a>').document.querySelector('a')
    // returning null lets the specialized (earlier-registered) conversion win
    expect(SNLinkImportExtension.html.import.a(anchor)).toBeNull()
    const plain = domino.createWindow('<a href="/x/status/1">https://x.com/x/status/1</a>').document.querySelector('a')
    expect(SNLinkImportExtension.html.import.a(plain)).toEqual({
      conversion: expect.any(Function),
      priority: 1
    })
  })
})
