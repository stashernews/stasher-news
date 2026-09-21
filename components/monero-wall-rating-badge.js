// 2.3 ★★⯨ (4) — average first, three proportionally filled stars, rater
// count in parens. Hidden when there are no ratings.
export default function MoneroWallRatingBadge ({ rating }) {
  if (!rating || rating.count === 0) return null
  const pct = Math.round((rating.average / 3) * 100)
  const label = `${rating.average} average from ${rating.count} rating${rating.count === 1 ? '' : 's'}`
  return (
    <span className='ms-2 text-nowrap' style={{ fontSize: '0.78rem' }} title={label} aria-label={label} role='img'>
      {rating.average}{' '}
      <span className='d-inline-block position-relative' aria-hidden='true'>
        <span className='text-muted'>★★★</span>
        <span className='position-absolute top-0 start-0 overflow-hidden' style={{ width: `${pct}%`, whiteSpace: 'nowrap', color: 'var(--bs-warning, #ffb347)' }}>
          ★★★
        </span>
      </span>{' '}
      ({rating.count})
    </span>
  )
}
