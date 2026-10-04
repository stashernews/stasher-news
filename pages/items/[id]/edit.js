import { useState } from 'react'
import { ITEM } from '@/fragments/items'
import { getGetServerSideProps } from '@/api/ssrApollo'
import { DiscussionForm } from '@/components/discussion-form'
import { LinkForm } from '@/components/link-form'
import { CenterLayout } from '@/components/layout'
import JobForm from '@/components/job-form'
import { PollForm } from '@/components/poll-form'
import { BountyForm } from '@/components/bounty-form'
import { useQuery } from '@apollo/client/react'
import { useRouter } from 'next/router'
import PageLoading from '@/components/page-loading'
import useCanEdit from '@/components/use-can-edit'
import Countdown from '@/components/countdown'
import { FeeButtonProvider } from '@/components/fee-button'
import { FormExpiredContext } from '@/components/form'
import ItemAddendumForm, { ExpiredFullEditNotice } from '@/components/item-addendum-form'
import ItemAddendum from '@/components/item-addendum'
import Text from '@/components/text'
import { UNKNOWN_LINK_REL } from '@/lib/constants'

export const getServerSideProps = getGetServerSideProps({
  query: ITEM,
  notFound: data => !data.item
})

export default function PostEdit ({ ssrData }) {
  const router = useRouter()
  const { data } = useQuery(ITEM, { variables: { id: router.query.id } })
  if (!data && !ssrData) return <PageLoading />

  const { item } = data || ssrData
  const subs = item.subNames

  const [canEdit, , editThreshold, editMode] = useCanEdit(item)
  // the mode when this route mounted: a FULL window expiring while the page is
  // open must keep the typed form mounted (finding #3) — no swap to the
  // addendum editor, no unmount/copy-loss — with an expiry notice and every
  // submission path refused
  const [modeAtOpen] = useState(editMode)
  const fullEditExpired = modeAtOpen === 'FULL' && editMode === 'ADDENDUM'
  const EditInfo = editThreshold && item.payIn?.payInState === 'PAID'
    ? <div className='text-muted fw-bold font-monospace mt-1'><Countdown date={editThreshold} /></div>
    : null

  // Post-window addendum (2026-10-04 spec): the original is locked; the author
  // gets only the free 200-character addendum editor below the locked body.
  // (A window that expired while the full editor was open stays on the full
  // form above — see fullEditExpired.)
  if (editMode === 'ADDENDUM' && !fullEditExpired) {
    return (
      <CenterLayout>
        <Text
          className='mb-1'
          topLevel
          state={item.lexicalState}
          html={item.html}
          rel={item.rel ?? UNKNOWN_LINK_REL}
          imgproxyUrls={item.imgproxyUrls}
        />
        <ItemAddendum item={item} topLevel />
        <ItemAddendumForm
          item={item}
          onSuccess={() => router.push(`/items/${item.id}`)}
          onCancel={() => router.push(`/items/${item.id}`)}
        />
      </CenterLayout>
    )
  }

  let FormType = DiscussionForm
  if (item.isJob) {
    FormType = JobForm
  } else if (item.url) {
    FormType = LinkForm
  } else if (item.pollCost) {
    FormType = PollForm
  } else if (Number(item.bountyPiconeros) > 0) {
    FormType = BountyForm
  }

  return (
    <CenterLayout>
      <FeeButtonProvider>
        <FormExpiredContext.Provider value={fullEditExpired}>
          <FormType item={item} subs={subs} EditInfo={canEdit && !fullEditExpired ? EditInfo : null}>
            <div className='text-muted fw-bold font-monospace mt-1'>
              turf{item.subNames?.length === 1 ? '' : 's'}: {item.subNames?.join(', ')} — use the repost action to add another
            </div>
          </FormType>
        </FormExpiredContext.Provider>
        {fullEditExpired && (
          <ExpiredFullEditNotice onCancel={() => router.push(`/items/${item.id}`)} />
        )}
      </FeeButtonProvider>
    </CenterLayout>
  )
}
