import { ITEM } from '@/fragments/items'
import { getGetServerSideProps } from '@/api/ssrApollo'
import { DiscussionForm } from '@/components/discussion-form'
import { LinkForm } from '@/components/link-form'
import { CenterLayout } from '@/components/layout'
import JobForm from '@/components/job-form'
import { PollForm } from '@/components/poll-form'
import { BountyForm } from '@/components/bounty-form'
import { useState } from 'react'
import { useQuery } from '@apollo/client/react'
import { useRouter } from 'next/router'
import PageLoading from '@/components/page-loading'
import { SubMultiSelect } from '@/components/sub-select'
import useCanEdit from '@/components/use-can-edit'
import Countdown from '@/components/countdown'

export const getServerSideProps = getGetServerSideProps({
  query: ITEM,
  notFound: data => !data.item
})

export default function PostEdit ({ ssrData }) {
  const router = useRouter()
  const { data } = useQuery(ITEM, { variables: { id: router.query.id } })
  if (!data && !ssrData) return <PageLoading />

  const { item } = data || ssrData
  const [subs, setSubs] = useState(item.subNames)

  const [,, editThreshold] = useCanEdit(item)
  const EditInfo = editThreshold && item.payIn?.payInState === 'PAID'
    ? <div className='text-muted fw-bold font-monospace mt-1'><Countdown date={editThreshold} /></div>
    : null

  let FormType = DiscussionForm
  let itemType = 'DISCUSSION'
  if (item.isJob) {
    FormType = JobForm
    itemType = 'JOB'
  } else if (item.url) {
    FormType = LinkForm
    itemType = 'LINK'
  } else if (item.pollCost) {
    FormType = PollForm
    itemType = 'POLL'
  } else if (item.bounty) {
    FormType = BountyForm
    itemType = 'BOUNTY'
  }

  return (
    <CenterLayout>
      <FormType item={item} subs={subs} EditInfo={EditInfo}>
        {!item.isJob &&
          <SubMultiSelect
            placeholder='pick turfs'
            className='d-flex'
            size='md'
            label='turf'
            filterSubs={s => s.name !== 'jobs' && s.postTypes?.includes(itemType)}
            onChange={(_, e) => setSubs(e)}
            subs={subs}
          />}
      </FormType>
    </CenterLayout>
  )
}
