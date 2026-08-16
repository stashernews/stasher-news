import { extractUrls } from '@/lib/md'
import { isJob } from '@/lib/item'
import { decodeProxyUrl } from '@/lib/url'
import { imgProxyEnabled, createImgproxyPath } from '@/lib/imgproxy'
import { snFetch } from '@/lib/fetch'
import { logInfo, logWarn } from '@/lib/logger'

if (!imgProxyEnabled) {
  console.warn('IMGPROXY_* env vars not set, imgproxy calls are no-ops now')
}

const IMGPROXY_URL = process.env.IMGPROXY_URL_DOCKER || process.env.NEXT_PUBLIC_IMGPROXY_URL
const MEDIA_CHECK_URL = process.env.MEDIA_CHECK_URL_DOCKER || process.env.NEXT_PUBLIC_MEDIA_CHECK_URL

const cache = new Map()

// based on heuristics. see https://stasher.news/items/266838
const imageUrlMatchers = [
  u => u.host === 'i.postimg.cc',
  u => u.host === 'pbs.twimg.com',
  u => u.host === 'i.ibb.co',
  u => u.host === 'nostr.build' || u.host === 'cdn.nostr.build',
  u => u.host === 'www.zapread.com' && u.pathname.startsWith('/i'),
  u => u.host === 'i.imgflip.com',
  u => u.host === 'i.redd.it',
  u => u.host === 'media.tenor.com',
  u => u.host === 'i.imgur.com'
]
const exclude = [
  u => process.env.NODE_ENV === 'production' && u.protocol !== 'https:',
  u => u.host.endsWith('.onion') || u.host.endsWith('.b32.ip') || u.host.endsWith('.loki'),
  u => ['twitter.com', 'x.com', 'nitter.it', 'nitter.at', 'xcancel.com'].some(h => h === u.host),
  u => u.host === 'stasher.news',
  u => u.host === 'news.ycombinator.com',
  u => u.host === 'www.youtube.com' || u.host === 'youtu.be',
  u => u.host === 'github.com'
]

function matchUrl (matchers, url) {
  try {
    return matchers.some(matcher => matcher(new URL(url)))
  } catch (err) {
    logWarn({ url, error: err?.message }, 'imgproxy url check failed')
    return false
  }
}

export async function imgproxy ({ data: { id, forceFetch = false }, models }) {
  if (!imgProxyEnabled) return

  const item = await models.item.findUnique({ where: { id } })

  let imgproxyUrls = {}
  if (item.text) {
    imgproxyUrls = await createImgproxyUrls(id, item.text, { models, forceFetch })
  }
  if (item.url && !isJob(item)) {
    imgproxyUrls = { ...imgproxyUrls, ...(await createImgproxyUrls(id, item.url, { models, forceFetch })) }
  }

  logInfo({ itemId: id }, 'imgproxy: updating item urls')

  await models.item.update({ where: { id }, data: { imgproxyUrls } })
}

export const createImgproxyUrls = async (id, text, { models, forceFetch }) => {
  const urls = extractUrls(text)
  logInfo({ itemId: id }, 'imgproxy: extracted urls')
  // resolutions that we target:
  //   - nHD:  640x 360
  //   - qHD:  960x 540
  //   - HD:  1280x 720
  //   - HD+: 1600x 900
  //   - FHD: 1920x1080
  //   - QHD: 2560x1440
  // reference:
  //   - https://en.wikipedia.org/wiki/Graphics_display_resolution#High-definition_(HD_and_derivatives)
  //   - https://www.browserstack.com/guide/ideal-screen-sizes-for-responsive-design
  const resolutions = ['640x360', '960x540', '1280x720', '1600x900', '1920x1080', '2560x1440']
  const imgproxyUrls = {}
  for (let url of urls) {
    if (!url) continue
    let fetchUrl = url
    if (process.env.MEDIA_URL_DOCKER) {
      fetchUrl = url.replace(process.env.NEXT_PUBLIC_MEDIA_URL, process.env.MEDIA_URL_DOCKER)
    }

    if (url.startsWith(IMGPROXY_URL)) {
      // backwards compatibility: we used to replace image urls with imgproxy urls
      url = decodeProxyUrl(url)
    }
    if (!(await isMediaURL(fetchUrl, { forceFetch }))) {
      continue
    }
    imgproxyUrls[url] = {}
    try {
      imgproxyUrls[url] = await getMetadata(fetchUrl)
      logInfo({ itemId: id }, 'imgproxy: dimensions fetched')
    } catch (err) {
      logWarn({ itemId: id, error: err?.message }, 'imgproxy: error getting dimensions')
    }
    for (const res of resolutions) {
      const [w, h] = res.split('x')
      const processingOptions = `/rs:fit:${w}:${h}`
      imgproxyUrls[url][`${w}w`] = createImgproxyPath({ url: fetchUrl, options: processingOptions })
    }
  }
  return imgproxyUrls
}

const getMetadata = async (url) => {
  // video metadata, dimensions, format
  const options = '/vm:1/d:1/f:1'
  const imgproxyUrl = new URL(createImgproxyPath({ url, options, pathname: '/info' }), IMGPROXY_URL).toString()
  const res = await fetch(imgproxyUrl)
  const { width, height, format, video_streams: videoStreams } = await res.json()
  return { dimensions: { width, height }, format, video: !!videoStreams?.length }
}

const isMediaURL = async (url, { forceFetch }) => {
  if (cache.has(url)) return cache.get(url)

  if (!forceFetch && matchUrl(imageUrlMatchers, url)) {
    return true
  }
  if (!forceFetch && matchUrl(exclude, url)) {
    return false
  }

  let isMedia = false

  // primary: media check service
  try {
    const res = await fetch(`${MEDIA_CHECK_URL}/${encodeURIComponent(url)}`)
    if (res.ok) {
      const data = await res.json()
      isMedia = data.isImage || data.isVideo
      cache.set(url, isMedia)
      return isMedia
    }
  } catch (err) {
    logWarn({ url, error: err?.message }, 'imgproxy: media check failed, falling back to direct fetch')
  }

  // fallback: first run HEAD with small timeout
  try {
    // https://stackoverflow.com/a/68118683
    const res = await snFetch(url, { timeout: 1000, method: 'HEAD' })
    const type = (res.headers.get('content-type') ?? '').toLowerCase()
    isMedia = type.startsWith('image/') || type.startsWith('video/')
  } catch (err) {
    logWarn({ url, error: err?.message }, 'imgproxy fetch failed')
  }

  // For HEAD requests, positives are most likely true positives.
  // However, negatives may be false negatives
  if (isMedia) {
    cache.set(url, true)
    return true
  }

  // if not known yet, run GET request with longer timeout
  try {
    const res = await snFetch(url, { timeout: 10000 })
    const type = (res.headers.get('content-type') ?? '').toLowerCase()
    res.body?.destroy?.() // we only needed the header; release the socket
    isMedia = type.startsWith('image/') || type.startsWith('video/')
  } catch (err) {
    logWarn({ url, error: err?.message }, 'imgproxy fetch failed')
  }

  cache.set(url, isMedia)
  return isMedia
}
