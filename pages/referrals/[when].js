import { gql } from 'graphql-tag'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { getGetServerSideProps } from '@/api/ssrApollo'
import { Select, DatePicker } from '@/components/form'
import Layout from '@/components/layout'
import { useMe } from '@/components/me'
import { useToast } from '@/components/toast'
import { useQuery } from '@apollo/client/react'
import PageLoading from '@/components/page-loading'
import { WHENS } from '@/lib/constants'
import dynamic from 'next/dynamic'
import { piconerosToXmr } from '@/lib/format'
import { whenToFrom } from '@/lib/time'
import { DISPLAY_FONT } from '@/lib/rebrand'
import copy from 'clipboard-copy'
import { WhenComposedChartSkeleton } from '@/components/charts-skeletons'
import styles from '@/styles/referrals.module.css'

const WhenComposedChart = dynamic(() => import('@/components/charts').then(mod => mod.WhenComposedChart), {
  loading: () => <WhenComposedChartSkeleton />
})

const REFERRALS = gql`
  query Referrals($when: String!, $from: String, $to: String) {
    referrals(when: $when, from: $from, to: $to) {
      time
      data {
        name
        value
      }
    }
    me {
      id
      optional {
        referrals(when: "forever")
      }
    }
  }`

export const getServerSideProps = getGetServerSideProps({ query: REFERRALS, authRequired: true })

export default function Referrals ({ ssrData }) {
  const router = useRouter()
  const { me } = useMe()

  const select = async values => {
    const { when, ...query } = values

    if (when !== 'custom') { delete query.from; delete query.to }
    if (query.from && !query.to) return

    await router.push({
      pathname: `/referrals/${when}`,
      query
    })
  }

  const { data } = useQuery(REFERRALS, { variables: { when: router.query.when, from: router.query.from, to: router.query.to } })
  if (!data && !ssrData) return <PageLoading />

  const { referrals } = data || ssrData
  const refCount = (data || ssrData).me.optional.referrals
  const totalPiconeros = referrals.reduce(
    (total, a) => total + BigInt(a.data?.find(d => d.name === 'referral piconeros')?.value ?? 0),
    0n)

  const when = router.query.when

  return (
    <Layout footerLinks>
      <div className='pt-5 pb-3 px-3 mx-auto text-center' style={{ maxWidth: '860px' }}>
        <h2 className='fw-bold text-muted'>referrals</h2>
        <div className='d-flex align-items-center justify-content-center flex-wrap gap-2'>
          <h4 className='fw-bold text-muted d-flex align-items-center justify-content-center mb-0'>
            {piconerosToXmr(totalPiconeros)} in the last
            <Select
              groupClassName='mb-0 mx-2'
              className='w-auto'
              name='when'
              size='sm'
              items={WHENS}
              value={router.query.when || 'day'}
              noForm
              onChange={(formik, e) => {
                const range = e.target.value === 'custom' ? { from: whenToFrom(when), to: Date.now() } : {}
                select({ when: e.target.value, ...range })
              }}
            />
          </h4>
          <span className={styles.countChip} title='stashers who signed up via your links, all time'>
            <span className='fw-bold fs-4 text-success'>{refCount}</span>
            <span className='text-muted text-small'>confirmed<br />referrals</span>
          </span>
        </div>
        {when === 'custom' &&
          <DatePicker
            noForm
            fromName='from'
            toName='to'
            className='p-0 px-2'
            onChange={(formik, [from, to], e) => {
              select({ when, from: from.getTime(), to: to.getTime() })
            }}
            from={router.query.from}
            to={router.query.to}
            when={router.query.when}
          />}
        <ReferralLink name={me.name} />
        <WhenComposedChart
          data={referrals}
          areaNames={['referral piconeros']}
          barNames={['referrals']}
          barAxis='right'
          barStackId={1}
        />
        <ul className='py-3 text-muted text-start mx-auto' style={{ width: 'fit-content' }}>
          <li>earn 10% of a stasher's <Link href='/rewards'>rewards</Link> in perpetuity if they sign up from your referral links</li>
          <li>nearly all sn links are referral links:
            <ul>
              <li>your profile link is an implicit referral link</li>
              <li>all links to post and comments are implicit referral links attributed to the OP</li>
              <li>links to turfs are implicit referral links attributed to the turf founder</li>
            </ul>
          </li>
          <li>appending /r/{me.name} to any SN link makes it a ref link to {me.name}</li>
          <li>your confirmed referrals count every stasher who signed up via one of your links</li>
        </ul>
      </div>
    </Layout>
  )
}

function ReferralLink ({ name }) {
  const toaster = useToast()
  const refLink = `${process.env.NEXT_PUBLIC_URL}/r/${name}`
  return (
    <div className='mt-4 mb-2'>
      <div className='text-small text-muted fw-bold text-uppercase'>your referral link</div>
      <button
        type='button'
        className={styles.copyLink}
        style={{ fontFamily: DISPLAY_FONT }}
        title={refLink}
        onClick={async () => {
          try {
            await copy(refLink)
            toaster.success('copied')
          } catch (err) {
            console.error('failed to copy referral link:', err)
            toaster.danger('failed to copy')
          }
        }}
      >
        {process.env.NEXT_PUBLIC_URL.replace(/^https?:\/\//, '')}/r/{name}
      </button>
      <div className='text-small text-muted'>click the link to copy it to your clipboard</div>
    </div>
  )
}
