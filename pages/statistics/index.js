import { useQuery } from '@apollo/client/react'
import { getGetServerSideProps } from '@/api/ssrApollo'
import Layout from '@/components/layout'
import MoreFooter from '@/components/more-footer'
import { STATISTICS } from '@/fragments/payIn'
import PayInTable, { PayInSkeleton } from '@/components/payIn/table'
import { useData } from '@/components/use-data'
import navStyles from '@/styles/nav.module.css'
import { Nav } from 'react-bootstrap'
import Link from 'next/link'
import { useRouter } from 'next/router'

export const getServerSideProps = getGetServerSideProps({ query: STATISTICS, authRequired: true, variables: { } })

export function SatisticsHeader () {
  const router = useRouter()
  const pathParts = router.asPath.split('?')[0].split('/').filter(segment => !!segment)
  const activeKey = pathParts[1] ?? 'history'
  return (
    <>
      <h2 className='mb-2 text-start'>Statistics</h2>
      <Nav
        className={navStyles.nav}
        activeKey={activeKey}
      >
        <Nav.Item>
          <Nav.Link as={Link} href='/statistics' eventKey='history'>history</Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link as={Link} href='/statistics/graphs/day' eventKey='graphs'>graphs</Nav.Link>
        </Nav.Item>
      </Nav>
    </>
  )
}

export default function Satistics ({ ssrData }) {
  const { data, fetchMore } = useQuery(STATISTICS, { variables: { } })
  const dat = useData(data, ssrData)
  if (!dat) {
    return (
      <Layout>
        <div className='mt-2'>
          <SatisticsHeader />
          <div className='py-2 px-0 mb-0 mw-100'>
            <PayInSkeleton header />
          </div>
        </div>
      </Layout>
    )
  }

  const { statistics: { payIns, cursor } } = dat

  return (
    <Layout>
      <div className='mt-2'>
        <SatisticsHeader />
        <div className='py-2 px-0 mb-0 mw-100'>
          <PayInTable payIns={payIns} />
        </div>
        <MoreFooter cursor={cursor} count={payIns?.length} fetchMore={fetchMore} Skeleton={PayInSkeleton} />
      </div>
    </Layout>
  )
}
