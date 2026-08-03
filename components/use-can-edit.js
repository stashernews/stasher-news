import { useState } from 'react'
import { datePivot } from '@/lib/time'
import { useMe } from '@/components/me'
import { ITEM_EDIT_SECONDS } from '@/lib/constants'

export default function useCanEdit (item) {
  const editThreshold = datePivot(new Date(item.payIn?.payInStateChangedAt ?? item.createdAt), { seconds: ITEM_EDIT_SECONDS })
  const { me } = useMe()

  // deleted items can never be edited and every item has a 10 minute edit window
  // except bios, they can always be edited but they should never show the countdown
  const noEdit = !!item.deletedAt || (Date.now() >= editThreshold) || item.bio
  const authorEdit = me && item.mine
  const [canEdit, setCanEdit] = useState(item.payIn?.payInState !== 'PAID' || (!noEdit && authorEdit))

  return [canEdit, setCanEdit, editThreshold]
}
