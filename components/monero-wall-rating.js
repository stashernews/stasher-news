import { useState } from 'react'
import { useMutation, useApolloClient } from '@apollo/client/react'
import gql from 'graphql-tag'
import { useToast } from './toast'
import styles from './monero-wall-rating.module.css'

export const RATE_MONERO_WALL_POST = gql`
  mutation RATE_MONERO_WALL_POST($itemId: ID!, $stars: Int!) {
    rateMoneroWallPost(itemId: $itemId, stars: $stars) {
      id
      moneroWallRating {
        average
        count
        myStars
        canRate
      }
    }
  }
`

const STAR_LABELS = { 1: 'not worth it', 2: 'mixed', 3: 'worth it' }

// End-of-body rating area. Eligible readers see the star control; locked,
// ineligible, or already-rated viewers see only the aggregate (or nothing when
// no ratings exist). Viewers whose payment is detected but not yet counted
// (pendingRating) see a hold note instead of the star control.
// Approved design (2026-09-21, see the UI reference): three large stars ARE
// the buttons — clicking the Nth star selects N stars (that star plus every
// star to its left fills golden; hover previews it), a live caption names
// the meaning, and submit is a deliberate second click because ratings are
// permanent. No visible radio controls; the stars are plain buttons.
export default function MoneroWallRating ({ item }) {
  const rating = item.moneroWallRating
  const [stars, setStars] = useState(null)
  const [hovered, setHovered] = useState(null)
  const [rate, { loading }] = useMutation(RATE_MONERO_WALL_POST)
  const client = useApolloClient()
  const toaster = useToast()
  if (!rating) return null

  const aggLine = rating.count > 0
    ? `${rating.average} from ${rating.count} rating${rating.count === 1 ? '' : 's'}`
    : 'no ratings yet'

  if (rating.pendingRating) {
    return (
      <div className={styles.footer}>
        <p className={styles.label}>was it worth it?</p>
        <p className={styles.aggregate}>your rating unlocks after a few confirmations — check back shortly.</p>
      </div>
    )
  }

  if (!rating.canRate) {
    if (rating.count === 0) return null
    const pct = Math.round((rating.average / 3) * 100)
    return (
      <div className={styles.footer}>
        <p className={styles.aggregate}>
          <span className={styles.aggStars} aria-hidden='true'>
            <span className={styles.aggStarsBase}>★★★</span>
            <span className={styles.aggStarsFill} style={{ width: `${pct}%` }}>★★★</span>
          </span>
          {' '}{aggLine}
        </p>
      </div>
    )
  }

  if (rating.myStars != null) {
    return (
      <div className={styles.footer}>
        <p className={styles.readonlyStars} aria-label={`you rated ${rating.myStars} of 3 stars`}>
          {'★'.repeat(rating.myStars)}
        </p>
        <p className={styles.aggregate}>you rated {'★'.repeat(rating.myStars)} &nbsp;·&nbsp; {aggLine}</p>
      </div>
    )
  }

  const shown = hovered ?? stars

  const onSubmit = async () => {
    try {
      await rate({ variables: { itemId: item.id, stars } })
    } catch (err) {
      toaster.danger(err?.message ?? 'failed to rate')
      client.refetchQueries({ include: ['Item'] }).catch(() => {})
    }
  }

  return (
    <div className={styles.footer}>
      <p className={styles.label}>was it worth it?</p>
      <div
        className={styles.starRow}
        role='radiogroup'
        aria-label='rate this post from 1 to 3 stars'
        onMouseLeave={() => setHovered(null)}
      >
        {[1, 2, 3].map(n => (
          <button
            key={n}
            type='button'
            className={`${styles.star}${shown != null && n <= shown ? ` ${styles.starOn}` : ''}`}
            onMouseEnter={() => setHovered(n)}
            onFocus={() => setHovered(n)}
            onBlur={() => setHovered(null)}
            onClick={() => setStars(n)}
            aria-label={`${n} star${n === 1 ? '' : 's'}, ${STAR_LABELS[n]}`}
            aria-pressed={stars === n}
          >
            ★
          </button>
        ))}
      </div>
      <p className={styles.caption}>{stars != null ? STAR_LABELS[stars] : ''}</p>
      <div className={styles.row}>
        <button
          type='button'
          className='btn btn-primary btn-sm'
          disabled={stars == null || loading}
          onClick={onSubmit}
        >
          submit rating
        </button>
      </div>
    </div>
  )
}
