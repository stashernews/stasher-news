import { useQuery } from '@apollo/client/react'
import Item, { ItemSkeleton } from './item'
import ItemCard from './item-card'
import ItemJob from './item-job'
import styles from './item.module.css'
import MoreFooter from './more-footer'
import { Fragment, useCallback, useMemo } from 'react'
import { CommentFlat } from './comment'
import { SUB_ITEMS } from '@/fragments/subs'
import { LIMIT } from '@/lib/cursor'
import { useRebrand } from '@/lib/rebrand'

import { useData } from './use-data'

const DEFAULT_FILTER = () => true
const DEFAULT_VARIABLES = {}

export default function Items ({ ssrData, variables = DEFAULT_VARIABLES, query, destructureData, rank, noMoreText, Footer, Header, filter = DEFAULT_FILTER }) {
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

  const itemsWithPins = useMemo(() => {
    if (!pins) return items

    const res = [...items]
    pins?.forEach(p => {
      if (p.position <= res.length) {
        res.splice(p.position - 1, 0, p)
      } else {
        res.push(p)
      }
    })
    return res
  }, [pins, items])

  const Skeleton = useCallback(() =>
    <ItemsSkeleton rank={rank} startRank={items?.length} limit={variables.limit} Footer={Foooter} />, [rank, items])

  if (!dat) {
    return <Skeleton />
  }

  const isHome = !variables?.sub

  return (
    <>
      {Header && <Header data={destructured} />}
      <div className={styles.grid}>
        {itemsWithPins.filter(filter).map((item, i) => (
          <ListItem key={`${item.id}-${i + 1}`} item={item} rank={rank && i + 1} itemClassName={variables.includeComments ? 'py-2' : ''} pinnable={isHome ? false : pins?.length > 0} />
        ))}
      </div>
      <Foooter
        cursor={cursor} fetchMore={fetchMore} noMoreText={noMoreText}
        count={items?.length}
        Skeleton={Skeleton}
      />
    </>
  )
}

// Selects the row renderer for a plain (non-comment, non-job) item: the card
// wrapper when the rebrand flag is on, the legacy row otherwise. Pure and
// exported so the flag choice is testable without a render harness.
export function itemRenderer (rebrand) {
  return rebrand ? ItemCard : Item
}

export function ListItem ({ item, ...props }) {
  const rebrand = useRebrand()

  if (item.parentId) {
    return <CommentFlat item={item} noReply includeParent search {...props} />
  }
  if (item.isJob) {
    return <ItemJob item={item} />
  }

  const Comp = itemRenderer(rebrand)
  return <Comp item={item} {...props} />
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
