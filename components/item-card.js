import Item from './item'

// Rebrand card wrapper around the existing listing row. The card chrome is a
// plain div; every datum of the legacy row (rank, vote column, tip/downvote
// amounts, comments with stashed/cost/boost tooltip, @user + badges, time,
// turf, action dropdown) still renders inside <Item> — nothing is re-rendered
// here. The server-computed `excerpt` field (see lib/excerpt.js) is forwarded
// to <Item>, which renders it as a 2-line clamped block between the title row
// and the details line; when absent the card shows title-only.
// Flag-off callers render the plain <Item> row instead (see components/items.js).
export default function ItemCard ({ item, rank, ...props }) {
  const excerpt = item?.excerpt
  return (
    <div className='item-card'>
      <Item item={item} rank={rank} excerpt={excerpt} {...props} />
    </div>
  )
}
