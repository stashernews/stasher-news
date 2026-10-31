import FeedViewControl from './feed-view-control'

// Frontpage heading block (terminal prompt, title,
// tagline, feed view switch). Rendered above the feed on the frontpage only.
export default function FrontpageHeader () {
  return (
    <div className='fp-head'>
      <div className='fp-prompt' aria-hidden='true'>$ cd /</div>
      <div className='fp-row'>
        <h1 className='fp-title'>frontpage</h1>
        <span className='fp-tag'>everything, ranked with Monero</span>
        <FeedViewControl className='fp-view' />
      </div>
    </div>
  )
}
