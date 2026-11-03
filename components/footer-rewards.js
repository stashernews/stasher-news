import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import Link from 'next/link'
import { RewardLine } from '@/pages/rewards'
import { LONG_POLL_INTERVAL_MS, SSR } from '@/lib/constants'

const REWARDS = gql`
{
  rewards {
    time
  }
  curatorBudget {
    mode
    fallbackBudgetPiconeros
    projectedPiconeros
  }
}`

export default function Rewards () {
  const { data } = useQuery(REWARDS, SSR ? { ssr: false } : { pollInterval: LONG_POLL_INTERVAL_MS, nextFetchPolicy: 'cache-and-network' })
  const budget = data?.curatorBudget
  return (
    <Link href='/rewards' className='nav-link p-0 p-0 d-inline-flex'>
      {budget
        ? <RewardLine budget={budget} time={data?.rewards?.[0]?.time} />
        : 'rewards'}
    </Link>
  )
}
