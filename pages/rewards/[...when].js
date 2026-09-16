import { useQuery } from '@apollo/client/react'
import PageLoading from '@/components/page-loading'
import { ME_REWARDS } from '@/fragments/rewards'
import { CenterLayout } from '@/components/layout'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/router'
import { getGetServerSideProps } from '@/api/ssrApollo'
import { fixedDecimal, piconerosToMXmr } from '@/lib/format'
import Trophy from '@/svgs/trophy-fill.svg'
import { ListItem } from '@/components/items'
import { dayMonthYear } from '@/lib/time'
import { GrowthPieChartSkeleton } from '@/components/charts-skeletons'
import { useMemo } from 'react'
import { payTypeShortName } from '@/lib/pay-in'

const GrowthPieChart = dynamic(() => import('@/components/charts').then(mod => mod.GrowthPieChart), {
  loading: () => <GrowthPieChartSkeleton />
})

export const getServerSideProps = getGetServerSideProps({
  query: ME_REWARDS,
  notFound: (data, params) => data.rewards.reduce((a, r) => a || new Date(r.time) > new Date(), false)
})

export default function Rewards ({ ssrData }) {
  const router = useRouter()
  const { data } = useQuery(ME_REWARDS, { variables: { ...router.query } })
  if (!data && !ssrData) return <PageLoading />

  const { rewards, meRewards } = data || ssrData

  return (
    <CenterLayout footerLinks>
      <div className='mw-100'>
        {rewards.map(({ total, sources, time, periodStart, periodEnd }, i) => (
          <RewardRecord key={time} total={total} sources={sources} time={time} periodStart={periodStart} periodEnd={periodEnd} meRewards={meRewards?.[i]} />
        ))}
      </div>
    </CenterLayout>
  )
}

function RewardRecord ({ total, sources, time, periodStart, periodEnd, meRewards }) {
  const sourcesData = useMemo(() => {
    return sources.map(({ name, value }) => ({ name: payTypeShortName(name), value: Number(value) }))
  }, [sources])
  return (
    <div className='py-3 w-100 d-grid' key={time} style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <h4 className='fw-bold text-muted ps-0'>
        {time && <div className='text-muted fst-italic fs-6 fw-normal pb-1'>On {dayMonthYear(time)} at 12a UTC</div>}
        {periodStart && periodEnd &&
          <div className='text-muted fst-italic fs-6 fw-normal pb-1'>weekly distribution covering {dayMonthYear(periodStart)} – {dayMonthYear(periodEnd)}</div>}
        {piconerosToMXmr(BigInt(total))} were rewarded
      </h4>
      <div className='my-3 w-100 justify-self-center'>
        <GrowthPieChart data={sourcesData} />
      </div>
      {meRewards &&
        <div className='justify-self-center mw-100'>
          <h4 className='fw-bold text-muted'>
            you earned {piconerosToMXmr(BigInt(meRewards.total))} ({fixedDecimal(meRewards.total * 100 / total, 2)}%)
          </h4>
          <div>
            {meRewards.rewards?.map((r, i) => <Reward key={[r.rank, r.type].join('-')} {...r} />)}
          </div>
        </div>}
    </div>
  )
}

function Reward ({ rank, type, piconeros, item }) {
  if (!rank) return null

  const color = rank <= 10 ? 'text-primary' : 'text-muted'

  let category = type
  switch (type) {
    case 'TIP_POST':
      category = 'in post tipping'
      break
    case 'TIP_COMMENT':
      category = 'in comment tipping'
      break
    case 'POST':
      category = 'among posts'
      break
    case 'COMMENT':
      category = 'among comments'
      break
  }

  return (
    <div>
      <div className={color}>
        <Trophy height={20} width={20} /> <b>#{rank}</b> {category} for <i><b>{piconerosToMXmr(BigInt(piconeros))}</b></i>
      </div>
      {item &&
        <div className={item.parentId ? 'pt-0' : 'pt-2'}>
          <ListItem item={item} />
        </div>}
    </div>
  )
}
