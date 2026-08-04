import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { getGetServerSideProps } from '@/api/ssrApollo'
import Layout from '@/components/layout'
import Col from 'react-bootstrap/Col'
import Row from 'react-bootstrap/Row'
import { SatisticsHeader } from '@/pages/statistics'
import { useRouter } from 'next/router'
import dynamic from 'next/dynamic'
import PageLoading from '@/components/page-loading'
import { WhenAreaChartSkeleton, WhenLineChartSkeleton } from '@/components/charts-skeletons'
import { UserAnalyticsHeader } from '@/components/user-analytics-header'
import { piconerosToXmr } from '@/lib/format'

const WhenAreaChart = dynamic(() => import('@/components/charts').then(mod => mod.WhenAreaChart), {
  loading: () => <WhenAreaChartSkeleton />
})
const WhenLineChart = dynamic(() => import('@/components/charts').then(mod => mod.WhenLineChart), {
  loading: () => <WhenLineChartSkeleton />
})
// const WhenComposedChart = dynamic(() => import('@/components/charts').then(mod => mod.WhenComposedChart), {
//   loading: () => <WhenComposedChartSkeleton />
// })

const GROWTH_QUERY = gql`
  query Growth($when: String!, $from: String, $to: String)
  {
    growthTotals(when: $when, from: $from, to: $to, mine: true) {
      spending
      stashing
      items
    }
    itemGrowth(when: $when, from: $from, to: $to, mine: true) {
      time
      data {
        name
        value
      }
    }
    spendingGrowth(when: $when, from: $from, to: $to, mine: true) {
      time
      data {
        name
        value
      }
    }
    stashingGrowth(when: $when, from: $from, to: $to, mine: true) {
      time
      data {
        name
        value
      }
    }
  }`

export const getServerSideProps = getGetServerSideProps({ query: GROWTH_QUERY })

function UserGrowthTotals ({ totals }) {
  if (!totals) return null

  return (
    <Row className='my-4'>
      <Col xs={6} md={4} className='text-center mb-3'>
        <div className='text-muted small'>total stashed</div>
        <div className='fw-bold fs-5'>{piconerosToXmr(BigInt(Math.floor(totals.stashing)) * 1000n)}</div>
      </Col>
      <Col xs={6} md={4} className='text-center mb-3'>
        <div className='text-muted small'>total spent</div>
        <div className='fw-bold fs-5'>{piconerosToXmr(BigInt(Math.floor(totals.spending)) * 1000n)}</div>
      </Col>
      <Col xs={6} md={4} className='text-center mb-3'>
        <div className='text-muted small'>spend actions</div>
        <div className='fw-bold fs-5'>{new Intl.NumberFormat().format(totals.items)}</div>
      </Col>
    </Row>
  )
}

export default function Growth ({ ssrData }) {
  const router = useRouter()
  const { when, from, to } = router.query

  const { data } = useQuery(GROWTH_QUERY, { variables: { when, from, to, mine: true } })
  if (!data && !ssrData) return <PageLoading />

  const {
    growthTotals,
    itemGrowth,
    spendingGrowth,
    stashingGrowth
  } = data || ssrData

  return (
    <Layout>
      <SatisticsHeader />
      <UserAnalyticsHeader pathname='statistics/graphs' />
      <UserGrowthTotals totals={growthTotals} />
      <Row>
        <Col className='mt-3'>
          <div className='text-center text-muted fw-bold'>XMR stashed</div>
          <WhenAreaChart data={stashingGrowth} />
        </Col>
        <Col className='mt-3'>
          <div className='text-center text-muted fw-bold'>XMR spent</div>
          <WhenAreaChart data={spendingGrowth} />
        </Col>
      </Row>
      <Row>
        <Col className='mt-3'>
          <div className='text-center text-muted fw-bold'>spend counts</div>
          <WhenLineChart data={itemGrowth} />
        </Col>
        <Col className='mt-3' />
      </Row>
    </Layout>
  )
}
