/* eslint-env jest */

import { parseInternalLinks, isMisleadingLink, parseEmbedUrl } from './url.js'

const internalLinkCases = [
  ['https://stasher.news/items/123', '#123'],
  ['https://stasher.news/items/123/related', '#123/related'],
  // invalid links should not be parsed so user can spot error
  ['https://stasher.news/items/123foobar', undefined],
  // Invalid origin should not be parsed so no malicious links
  ['https://example.com/items/123', undefined],
  // parse referral links
  ['https://stasher.news/items/123/r/ekzyis', '#123'],
  // use comment id if available
  ['https://stasher.news/items/123?commentId=456', '#456'],
  // comment id + referral link
  ['https://stasher.news/items/123/r/ekzyis?commentId=456', '#456'],
  // multiple params
  ['https://stasher.news/items/123?commentId=456&parentId=789', '#456']
]

describe('internal links', () => {
  test.each(internalLinkCases)(
    'parses %p as %p',
    (href, expected) => {
      process.env.NEXT_PUBLIC_URL = 'https://stasher.news'
      const { linkText: actual } = parseInternalLinks(href)
      expect(actual).toBe(expected)
    }
  )
})

const misleadingLinkCases = [
  // if text is the same as the link, it's not misleading
  ['https://stasher.news/items/1234', 'https://stasher.news/items/1234', false],
  // same origin is not misleading
  ['https://stasher.news/items/1235', 'https://stasher.news/items/1234', false],
  ['www.google.com', 'https://www.google.com', false],
  ['stasher.news', 'https://stasher.news', false],
  // if text is obviously not a link, it's not misleading
  ['innocent text', 'https://stasher.news/items/1234', false],
  ['innocenttext', 'https://stasher.news/items/1234', false],
  // if text might be a link to a different origin, it's misleading
  ['innocent.text', 'https://stasher.news/items/1234', true],
  ['https://google.com', 'https://bing.com', true],
  ['www.google.com', 'https://bing.com', true],
  ['s-tacker.news', 'https://snacker.news', true],
  // don't catch edge cases with spaces
  ['11.1 percent', 'https://example.com', false],
  ['for 11.1 percent', 'https://example.com', false],
  ['v11.1', 'https://example.com', false],
  // don't catch numeric-only, except for IP addresses
  ['11.1', 'https://example.com', false],
  ['11.1.0', 'https://example.com', false],
  ['11.1.0.0', 'https://example.com', true]
]

describe('misleading links', () => {
  test.each(misleadingLinkCases)(
    'identifies [%p](%p) as misleading: %p',
    (text, href, expected) => {
      const actual = isMisleadingLink(text, href)
      expect(actual).toBe(expected)
    }
  )
})

const nostrEmbedUrlCases = [
  ['https://njump.me/nprofile1qqsfy7f8d0lms08wxw2xu4jvxcq2x2zqy6dgypksrh05p3jr9w4qhjc2xjd74', true],
  ['https://yakihonne.com/note/nevent1qgsfy7f8d0lms08wxw2xu4jvxcq2x2zqy6dgypksrh05p3jr9w4qhjcppemhxue69uhkummn9ekx7mp0qy2hwumn8ghj7un9d3shjtnyv9kh2uewd9hj7qpqa56frq6ljgdeh85rntn50yv3c9u5ffkd26nzs698h9xuljtezljs98kq07', true],
  ['https://npub1nsyte9neefm3jle7dg5gw6mhchxyk75a6f5dng70l4l3a2mx0nashqv2jk.nsite.lol/', false],
  ['https://njump.me/nevent1qgsfy7f8d0lms08wxw2xu4jvxcq2x2zqy6dgypksrh05p3jr9w4qhjcppemhxue69uhkummn9ekx7mp0qy2hwumn8ghj7un9d3shjtnyv9kh2uewd9hj7qpqa56frq6ljgdeh85rntn50yv3c9u5ffkd26nzs698h9xuljtezljs98kq07', true],
  ['https://primal.net/p/npub1jfujw6llhq7wuvu5detycdsq5v5yqf56sgrdq8wlgrryx2a2p09svwm0gx', true]
]

describe('embed nostr links', () => {
  test.each(nostrEmbedUrlCases)(
    'identifies %p as embed: %p',
    (url, expectedEmbed) => {
      const actual = parseEmbedUrl(url)
      if (expectedEmbed) {
        expect(actual).toMatchObject({ provider: 'nostr' })
      } else {
        expect(actual).toBeNull()
      }
    }
  )
})

const embedHostCases = [
  // real providers still match (subdomains included)
  ['https://rumble.com/embed/vabcde', 'rumble'],
  ['https://www.rumble.com/embed/abc.html', 'rumble'],
  ['https://wavlake.com/track/c0aaeff8-5a26-49cf-8dad-2b6909e4aed1', 'wavlake'],
  ['https://open.spotify.com/track/abc123', 'spotify'],
  ['https://www.youtube.com/watch?v=abc123', 'youtube'],
  ['https://youtu.be/abc123', 'youtube'],
  ['https://peertube.tv/w/abc', 'peertube'],
  ['https://bitcointv.com/w/abc', 'peertube'],
  // suffix-spoof attempts must NOT match (audit B-5)
  ['https://evilrumble.com/embed/login', null],
  ['https://xpeertube.tv/w/abc', null],
  ['https://evilbitcointv.com/w/abc', null],
  ['https://rumble.com.evil.com/embed/x', null],
  ['https://evilwavlake.com/track/x', null],
  ['https://evilspotify.com/track/x', null],
  ['https://evilyoutube.com/watch?v=x', null],
  ['https://evilyoutu.be/abc', null]
]

describe('embed host matching', () => {
  test.each(embedHostCases)('parses %p as %p', (href, provider) => {
    const actual = parseEmbedUrl(href)
    if (provider === null) {
      expect(actual).toBeNull()
    } else {
      expect(actual?.provider).toBe(provider)
    }
  })
})
