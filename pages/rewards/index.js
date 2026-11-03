import { gql } from 'graphql-tag'
import Button from 'react-bootstrap/Button'
import { getGetServerSideProps } from '@/api/ssrApollo'
import Layout from '@/components/layout'
import { useQuery } from '@apollo/client/react'
import Link from 'next/link'
import { piconerosToXmr } from '@/lib/format'
import { formatMultiple } from '@/lib/curatorBudgetCopy'
import PageLoading from '@/components/page-loading'
import { useShowModal } from '@/components/modal'
import dynamic from 'next/dynamic'
import { FAST_POLL_INTERVAL_MS, SSR } from '@/lib/constants'
import { Col, Row } from 'react-bootstrap'
import { useData } from '@/components/use-data'
import { GrowthPieChartSkeleton } from '@/components/charts-skeletons'
import { useMemo } from 'react'
import { CompactLongCountdown } from '@/components/countdown'
import { payTypeShortName } from '@/lib/pay-in'
import DonateModal from '@/components/donate-modal'
import { curatorBudgetHeadline } from '@/components/pool-health'

const GrowthPieChart = dynamic(() => import('@/components/charts').then(mod => mod.GrowthPieChart), {
  loading: () => <GrowthPieChartSkeleton />
})

const REWARDS_FULL = gql`
{
  rewards {
    time
    sources {
      name
      value
    }
  }
  curatorBudget {
    mode
    fallbackBudgetPiconeros
    projectedPiconeros
    multBps
    windingDown
  }
}
`

export const getServerSideProps = getGetServerSideProps({ query: REWARDS_FULL })

// Footer line: the next distribution's curator budget and its countdown.
// The reserve itself is never shown.
export function RewardLine ({ budget, time }) {
  const headline = curatorBudgetHeadline(budget)
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      Next rewards distribution: {headline?.amount ?? '—'}
      {time && <> in <CompactLongCountdown className='text-monospace' date={time} /></>}
    </span>
  )
}

function toBigInt (value) {
  return typeof value === 'bigint' ? value : BigInt(value)
}

export { DEFAULT_DRAWDOWN_WEEKS } from '@/lib/curatorBudgetCopy'

// The budget headline and the notes under it, per curator budget mode.
export function CuratorBudgetCopy ({ budget, time }) {
  const mode = budget?.mode ?? 'LEGACY'
  const headline = curatorBudgetHeadline(budget)
  const projected = mode === 'ACTIVE' ? budget?.projectedPiconeros : null
  // The EFFECTIVE multiple only. When T4 = 0 the budget is 0 and no effective
  // multiple exists (0/0) — render 0×, never the configured target k.
  const multiple = formatMultiple(budget?.multBps) ?? '0×'

  let shadowLine = null
  if (mode === 'SHADOW' && budget?.projectedPiconeros != null) {
    shadowLine = `Under the proposed dynamic budget this would be about ${piconerosToXmr(toBigInt(budget.projectedPiconeros))}` +
      ` (${multiple} recent curator tips).`
  }

  return (
    <div className='text-center text-muted'>
      <div><small>{projected != null ? 'Projected curator budget this week' : 'Curator budget this week'}</small></div>
      <div className='fs-2 fw-bold text-body'>{headline ? `${headline.upTo ? 'up to ' : ''}${headline.amount}` : '—'}</div>
      {time &&
        <div><small><CompactLongCountdown className='text-monospace' date={time} /></small></div>}
      <div className='small'>
        <small>
          {projected != null
            ? <>This is a projection; it is final at Monday 00:00 UTC.{budget.windingDown && ` (${multiple}: pool winding down)`}</>
            : 'Remaining funds roll over to the following week.'}
        </small>
      </div>
      {shadowLine && <div className='fst-italic'><small>{shadowLine}</small></div>}
      {mode === 'ACTIVE' && projected == null && (
        <div>
          <small>The live projection is temporarily unavailable, please check back shortly. Payouts are unaffected: curators receive the dynamic budget calculated at Monday's distribution, or the fallback cap above only if that calculation cannot run.</small>
        </div>
      )}
    </div>
  )
}

export default function Rewards ({ ssrData }) {
  // only poll for updates to rewards
  const { data } = useQuery(
    REWARDS_FULL,
    SSR ? {} : { pollInterval: FAST_POLL_INTERVAL_MS, nextFetchPolicy: 'cache-and-network' })
  const dat = useData(data, ssrData)

  const { sources, time } = useMemo(() => {
    const active = dat?.rewards?.[0]
    if (!active) return { sources: [], time: null }
    return {
      // this cycle's income by source; the rollover is never a source
      sources: active.sources.map(source => ({ name: payTypeShortName(source.name), value: Number(source.value) })),
      time: active.time
    }
  }, [dat])

  if (!dat) return <PageLoading />

  return (
    <Layout footerLinks>
      <Row className='pb-3'>
        <Col>
          <div
            className='d-flex flex-column sticky-lg-top py-5'
          >
            <CuratorBudgetCopy budget={dat.curatorBudget} time={time} />
            <div className='text-center mt-2'>
              <Link href='/faq#how-do-i-earn-xmr-on-stasher-news' className='text-info fw-normal'>
                <small>learn about rewards</small>
              </Link>
              <span className='text-muted mx-2'>·</span>
              <Link href='/transparency' className='text-info fw-normal'>
                <small>wallet transparency</small>
              </Link>
            </div>
            <div className='my-3 w-100'>
              <div className='text-center text-muted'><small>This week's income</small></div>
              {sources?.length > 0
                ? <GrowthPieChart data={sources} />
                : <div className='text-center text-muted'><small><small>No income yet this week.</small></small></div>}
            </div>
            <DonateButton />
          </div>
        </Col>
      </Row>
    </Layout>
  )
}

export function DonateButton () {
  const showModal = useShowModal()

  return (
    <Button
      className='align-self-center'
      onClick={() => showModal(onClose => <DonateModal onClose={onClose} />)}
    >DONATE TO REWARDS
    </Button>
  )
}
