import { useMemo, useRef, useState } from 'react'
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

// true when any upload referenced by the post is a video — whether it is the
// post's link (url) or embedded in the body. Deliberately independent of the
// media-visibility settings: the video indicator is just an icon and loads no
// media, so it stays visible even when the user hides images/videos.
export function hasVideoUpload (imgproxyUrls) {
  return Object.values(imgproxyUrls ?? {}).some(entry => entry?.video)
}

// every embedded upload (MEDIA_URL/<id>) in the post, excluding the link-post
// url, in the order they appear in the body. imgproxyUrls is jsonb, which does
// not keep key order, so fall back to upload id order for keys not in the text.
export function pickUploadKeys (imgproxyUrls, itemUrl, text) {
  const mediaUrl = process.env.NEXT_PUBLIC_MEDIA_URL || `https://${process.env.NEXT_PUBLIC_MEDIA_DOMAIN}`
  const re = new RegExp(`^${escapeRe(mediaUrl)}/([0-9]+)$`)
  const pos = k => {
    const i = text ? text.indexOf(k) : -1
    return i === -1 ? Infinity : i
  }
  const id = k => Number(k.match(re)[1])
  return Object.keys(imgproxyUrls ?? {})
    .filter(k => k !== itemUrl && re.test(k))
    .sort((a, b) => (pos(a) - pos(b)) || (id(a) - id(b)))
}

export function CardMedia ({ item, onClick }) {
  const { me } = useMe()
  const [index, setIndex] = useState(0)
  const prevRef = useRef()
  const nextRef = useRef()
  const previews = useMemo(() => {
    // Monerowall: media embedded in the locked portion is hidden from rendered
    // output (spec 2026-09-18). `locked` is viewer-relative, so the author,
    // entitled viewers, and publicly unlocked posts still get the preview.
    if (item?.moneroWall?.locked) return []
    return pickUploadKeys(item?.imgproxyUrls, item?.url, item?.text)
      .map(key => item.imgproxyUrls[key])
      .filter(entry => !previewDisabled(me, entry))
      .map(entry => buildPreview(entry))
      .filter(Boolean)
  }, [item?.moneroWall?.locked, item?.imgproxyUrls, item?.url, item?.text, me])
  if (!previews.length) return null
  const current = Math.min(index, previews.length - 1)
  const preview = previews[current]
  const multi = previews.length > 1
  const title = item.title ?? `view post ${item.id}`
  // an end-of-gallery arrow unmounts on click; hand keyboard focus to the
  // other arrow so it is not dropped to the document
  const go = (to) => {
    setIndex(to)
    const other = to === 0 ? nextRef : to === previews.length - 1 ? prevRef : null
    if (other) window.requestAnimationFrame(() => other.current?.focus())
  }
  return (
    <div className='card-media d-block'>
      {/* --card-media-bg feeds the blurred letterbox behind the image (styles/retro-theme.scss) */}
      <div className={styles.wrap} style={{ '--card-media-bg': `url(${JSON.stringify(preview.src)})` }}>
        <Link
          href={`/items/${item.id}`}
          onClick={onClick}
          aria-label={multi ? `${title}, image ${current + 1} of ${previews.length}` : title}
          className={`${styles.link} text-reset`}
        >
          <img
            key={preview.src}
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
        </Link>
        {/* gallery controls: list and panel views only (hidden in the log view and
            notification thumbnails, styles/stealth-theme.scss) */}
        {multi && current > 0 && (
          <button
            type='button'
            className={`${styles.nav} ${styles.prev} card-media-nav`}
            ref={prevRef}
            aria-label='previous image'
            onClick={() => go(current - 1)}
          >
            <span aria-hidden='true'>‹</span>
          </button>
        )}
        {multi && current < previews.length - 1 && (
          <button
            type='button'
            className={`${styles.nav} ${styles.next} card-media-nav`}
            ref={nextRef}
            aria-label='next image'
            onClick={() => go(current + 1)}
          >
            <span aria-hidden='true'>›</span>
          </button>
        )}
        {multi && (
          <span className={`${styles.dots} card-media-nav`} aria-hidden='true'>
            {previews.map((p, i) => <span key={p.src} className={i === current ? styles.dotActive : styles.dot} />)}
          </span>
        )}
      </div>
    </div>
  )
}
