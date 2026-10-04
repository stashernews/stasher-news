import Text from './text'
import { UNKNOWN_LINK_REL } from '@/lib/constants'

// Post-window addendum (2026-10-04 spec): the single informational edit below
// a locked original, separated by a divider with an absolute last-edited time.
// Server and client both render the same deterministic `YYYY-MM-DD HH:mm UTC`
// string — no relative times, no locale-dependent hydration mismatch. Content
// gating (deleted/locked viewers) happens server-side; this component renders
// whatever it is given.
export default function ItemAddendum ({ item, topLevel = false, readerRef }) {
  if (!item?.addendumText || item?.deletedAt) return null
  const iso = new Date(item.addendumUpdatedAt).toISOString()
  return (
    <section className='sn-item-addendum'>
      <hr />
      <div className='text-muted small font-monospace sn-item-addendum-stamp'>
        last edited at: <time dateTime={iso}>{iso.slice(0, 16).replace('T', ' ')} UTC</time>
      </div>
      <Text
        topLevel={topLevel}
        state={item.addendumLexicalState}
        html={item.addendumHtml}
        imgproxyUrls={item.imgproxyUrls}
        rel={item.rel ?? UNKNOWN_LINK_REL}
        readerRef={readerRef}
      />
    </section>
  )
}
