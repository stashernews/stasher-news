import { visit } from 'unist-util-visit'
import { toString } from 'mdast-util-to-string'
import { isMisleadingLink, preferAbsoluteTextUrl } from '@/lib/url'
import { isImageOnlyLink } from '@/lib/lexical/mdast/shared'

/**
 * a link is misleading if the text is not the same as the URL.
 *
 * this transform replaces the link text with the URL if it is misleading.
 * if the link wraps only an image, the link is removed but the image is kept.
 */
export function misleadingLinkTransform (tree) {
  visit(tree, 'link', (node, index, parent) => {
    // if the link has only an image child, unwrap it (remove the link but keep the image)
    if (isImageOnlyLink(node) && parent && index !== undefined) {
      parent.children[index] = node.children[0]
      return index
    }

    const text = toString(node)
    if (!text) return
    if (!node.url) return

    if (isMisleadingLink(text, node.url)) {
      node.children = [{ type: 'text', value: node.url }]
    }
  })
}

/**
 * heals links whose href is relative while their text is the full absolute
 * URL (e.g. [https://x.com/h/status/1](/h/status/1), pasted from x.com's
 * root-relative DOM): the href resolves against our origin and 404s. the
 * visible URL is the intended target.
 */
export function relativeLinkHrefTransform (tree) {
  visit(tree, 'link', (node) => {
    if (!node.url) return
    const text = toString(node)
    if (!text) return
    node.url = preferAbsoluteTextUrl(node.url, text)
  })
}

/** LinkeDOM patch: decodeURI(url) fails on malformed URLs,
 * so we replace the link node with a text node */
export function malformedLinkEncodingTransform (tree) {
  visit(tree, 'link', (node, index, parent) => {
    if (!node.url) return

    try {
      decodeURI(node.url)
    } catch {
      if (parent && index !== undefined) {
        parent.children[index] = { type: 'text', value: node.url }
      } else {
        // note: we should never reach this case, if we do we probably have a RootNode as parent,
        // this might cause double encoding
        node.url = encodeURI(node.url)
      }
    }
  })
}
