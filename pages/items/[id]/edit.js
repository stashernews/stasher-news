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

  const [,, editThreshold] = useCanEdit(item)
  const EditInfo = editThreshold && item.payIn?.payInState === 'PAID'
    ? <div className='text-muted fw-bold font-monospace mt-1'><Countdown date={editThreshold} /></div>
    : null

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
        <FormType item={item} subs={subs} EditInfo={EditInfo}>
          <div className='text-muted fw-bold font-monospace mt-1'>
            turf{item.subNames?.length === 1 ? '' : 's'}: {item.subNames?.join(', ')} — use the repost action to add another
          </div>
        </FormType>
      </FeeButtonProvider>
    </CenterLayout>
  )
}
