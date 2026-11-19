/* eslint-env jest */
// cardPreviews decides both what CardMedia renders and whether the feed's X
// preview card may show its own image, so its gates are pinned here.
import { cardPreviews } from '@/components/card-media'

jest.mock(`${process.cwd()}/components/me`, () => ({ useMe: () => ({ me: null }) }))

const MEDIA = 'https://media.example.test'
const IMGPROXY = 'https://imgproxy.example.test'

let saved
beforeEach(() => {
  saved = { media: process.env.NEXT_PUBLIC_MEDIA_URL, imgproxy: process.env.NEXT_PUBLIC_IMGPROXY_URL }
  process.env.NEXT_PUBLIC_MEDIA_URL = MEDIA
  process.env.NEXT_PUBLIC_IMGPROXY_URL = IMGPROXY
})
afterEach(() => {
  process.env.NEXT_PUBLIC_MEDIA_URL = saved.media
  process.env.NEXT_PUBLIC_IMGPROXY_URL = saved.imgproxy
})

const upload = (id, extra = {}) => ({ [`${MEDIA}/${id}`]: { '640w': `/p/${id}/640`, ...extra } })

const tweetPost = (imgproxyUrls, extra = {}) => ({
  id: 1,
  url: 'https://x.com/someone/status/123',
  text: `![](${MEDIA}/7)`,
  imgproxyUrls,
  xPreview: { statusUrl: 'https://x.com/someone/status/123', image: { '640w': '/p/tweet/640' } },
  ...extra
})

describe('cardPreviews', () => {
  test('a body upload yields a preview', () => {
    const previews = cardPreviews(tweetPost(upload(7)), null)
    expect(previews).toHaveLength(1)
    expect(previews[0].src).toBe(`${IMGPROXY}/p/7/640`)
  })

  test('no uploads yields nothing, so the X card keeps its image', () => {
    expect(cardPreviews(tweetPost({}), null)).toEqual([])
    expect(cardPreviews(tweetPost(undefined), null)).toEqual([])
  })

  test('the link-post url itself is not counted as an upload', () => {
    const item = tweetPost(upload(7), { url: `${MEDIA}/7`, text: '' })
    expect(cardPreviews(item, null)).toEqual([])
  })

  test('hidden media setting yields nothing', () => {
    const me = { privates: { showImagesAndVideos: false } }
    expect(cardPreviews(tweetPost(upload(7)), me)).toEqual([])
  })

  test('imgproxyOnly drops video uploads but keeps images', () => {
    const me = { privates: { imgproxyOnly: true } }
    expect(cardPreviews(tweetPost(upload(7, { video: true })), me)).toEqual([])
    expect(cardPreviews(tweetPost(upload(7)), me)).toHaveLength(1)
  })

  test('a monerowall-locked post yields nothing', () => {
    expect(cardPreviews(tweetPost(upload(7), { moneroWall: { locked: true } }), null)).toEqual([])
  })
})
