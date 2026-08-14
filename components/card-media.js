import Link from 'next/link'
import { useMe } from './me'
import VideoIcon from '@/svgs/video-on-fill.svg'
import styles from './card-media.module.css'

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// first imgproxyUrls key that is an embedded upload (MEDIA_URL/<id>), excluding
// the link-post url. Reads env at call time so tests are deterministic.
export function pickUploadKey (imgproxyUrls, itemUrl) {
  const mediaUrl = process.env.NEXT_PUBLIC_MEDIA_URL || `https://${process.env.NEXT_PUBLIC_MEDIA_DOMAIN}`
  const re = new RegExp(`^${escapeRe(mediaUrl)}/([0-9]+)$`)
  return Object.keys(imgproxyUrls ?? {})
    .find(k => k !== itemUrl && re.test(k))
}

// turn an imgproxyUrls entry into a render descriptor, or null if unusable.
export function buildPreview (entry, { imgproxyUrl } = {}) {
  if (!entry?.['640w']) return null
  const base = imgproxyUrl || process.env.NEXT_PUBLIC_IMGPROXY_URL
  if (!base) return null
  const src = new URL(entry['640w'], base).href
  const preview = { src, isVideo: !!entry.video }
  if (entry['960w']) {
    preview.srcSet = `${src} 1x, ${new URL(entry['960w'], base).href} 2x`
  }
  const { width, height } = entry.dimensions ?? {}
  if (width && height) preview.aspectRatio = `${width} / ${height}`
  return preview
}

// user-settings gate (mirrors components/item.js mediaType:55-58)
export function previewDisabled (me, entry) {
  if (me?.privates?.showImagesAndVideos === false) return true
  if (me?.privates?.imgproxyOnly && entry?.video) return true
  return false
}

export function CardMedia ({ item, onClick }) {
  const { me } = useMe()
  const key = pickUploadKey(item?.imgproxyUrls, item?.url)
  if (!key) return null
  const entry = item.imgproxyUrls[key]
  if (previewDisabled(me, entry)) return null
  const preview = buildPreview(entry)
  if (!preview) return null
  return (
    <Link
      href={`/items/${item.id}`}
      onClick={onClick}
      aria-label={item.title ?? `view post ${item.id}`}
      className='d-block text-reset'
    >
      <div className={styles.wrap}>
        <img
          className={styles.img}
          src={preview.src}
          srcSet={preview.srcSet}
          alt=''
          loading='lazy'
          decoding='async'
          style={preview.aspectRatio ? { aspectRatio: preview.aspectRatio } : undefined}
        />
        {preview.isVideo && (
          <span className={styles.badge} aria-hidden='true'><VideoIcon className='fill-white' /></span>
        )}
      </div>
    </Link>
  )
}
