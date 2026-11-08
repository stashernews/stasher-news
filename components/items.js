import { useQuery } from '@apollo/client/react'
import { ItemSkeleton } from './item'
import ItemCard from './item-card'
import ItemJob from './item-job'
import styles from './item.module.css'
import MoreFooter from './more-footer'
import { Fragment, useCallback, useMemo } from 'react'
import { CommentFlat } from './comment'
import { SUB_ITEMS } from '@/fragments/subs'
import { LIMIT } from '@/lib/cursor'
import { turfPinPosition } from '@/lib/turf-pins'

import { useData } from './use-data'

const DEFAULT_FILTER = () => true
const DEFAULT_VARIABLES = {}

export default function Items ({ ssrData, variables = DEFAULT_VARIABLES, query, destructureData, rank, noMoreText, emptyText, Footer, Header, filter = DEFAULT_FILTER }) {
  const { data, fetchMore } = useQuery(query || SUB_ITEMS, { variables })
  const Foooter = Footer || MoreFooter
  const dat = useData(data, ssrData)

  const destructured = useMemo(() => {
    if (!dat) return {}
    if (destructureData) {
      return destructureData(dat)
    } else {
      return dat?.items
    }
  }, [dat])

  const { items, pins, cursor } = destructured

  // pin rendering is local to the feed that injected them: a post pinned in
  // another turf is an ordinary card here. Sub is the bound feed variable.
  const subName = variables?.sub
  const pinnedIds = useMemo(() => new Set((pins ?? []).map(p => p.id)), [pins])

  const itemsWithPins = useMemo(() => {
    if (!pins?.length) return items

    // turf feed: SQL returned the pins in this turf's position order and
    // their legacy position field is null, so the positional merge below
    // cannot apply — prepend the pin block consecutively and drop the ids
    // from the ordinary list (defensive: the server already excludes them)
    if (subName) {
      return [...pins, ...(items ?? []).filter(i => !pinnedIds.has(i.id))]
    }

    const res = [...items]
    pins?.forEach(p => {
      if (p.position <= res.length) {
        res.splice(p.position - 1, 0, p)
      } else {
        res.push(p)
      }
    })
    return res
  }, [pins, items, subName, pinnedIds])

  const Skeleton = useCallback(() =>
    <ItemsSkeleton rank={rank} startRank={items?.length} limit={variables.limit} Footer={Foooter} />, [rank, items])

  if (!dat) {
    return <Skeleton />
  }

  return (
    <>
      {Header && <Header data={destructured} />}
      <div className={styles.grid}>
        {itemsWithPins.filter(filter).map((item, i) => (
          <ListItem
            key={`${item.id}-${i + 1}`} item={item} rank={rank && i + 1}
            itemClassName={variables.includeComments ? 'py-2' : ''}
            pinPosition={subName && pinnedIds.has(item.id) ? turfPinPosition(item, subName) : null}
          />
        ))}
      </div>
      <Foooter
        cursor={cursor} fetchMore={fetchMore} noMoreText={noMoreText} emptyText={emptyText}
        count={items?.length}
        Skeleton={Skeleton}
      />
    </>
  )
}

export function ListItem ({ item, ...props }) {
  if (item.parentId) {
    return <CommentFlat item={item} noReply includeParent search {...props} />
  }
  if (item.isJob) {
    return <ItemJob item={item} />
  }

  return <ItemCard item={item} {...props} />
}

export function ItemsSkeleton ({ rank, startRank = 0, limit = LIMIT, Footer }) {
  const items = new Array(limit).fill(null)

  return (
    <>
      <div className={styles.grid}>
        {items.map((_, i) => (
          <ItemSkeleton rank={rank && i + startRank + 1} key={i + startRank} />
        ))}
      </div>
      <Footer invisible cursor />
    </>
  )
}
