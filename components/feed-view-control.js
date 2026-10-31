import useFeedView, { FEED_VIEWS } from './use-compact-view'

// list / log / panel feed view switch (footer and frontpage header)
export default function FeedViewControl ({ className = '' }) {
  const [feedView, chooseFeedView] = useFeedView()
  return (
    <span role='group' aria-label='feed view' className={`feed-view-group ${className}`}>
      <span className='me-1'>view:</span>
      {FEED_VIEWS.map(v => (
        <button key={v} type='button' aria-pressed={feedView === v} onClick={() => chooseFeedView(v)}>
          {feedView === v && <span aria-hidden='true'>[</span>}{v}{feedView === v && <span aria-hidden='true'>]</span>}
        </button>
      ))}
    </span>
  )
}
