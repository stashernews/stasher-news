import { useRouter } from 'next/router'
import { getGetServerSideProps } from '@/api/ssrApollo'
import Items from '@/components/items'
import Layout from '@/components/layout'
import { SUB_FULL, SUB_ITEMS } from '@/fragments/subs'
import FrontpageHeader from '@/components/frontpage-header'
import { useQuery } from '@apollo/client/react'
import PageLoading from '@/components/page-loading'
import TerritoryHeader from '@/components/territory-header'
import { feedSortRedirect } from '@/lib/feed-sort'

const getSubProps = getGetServerSideProps({
  query: SUB_ITEMS,
  notFound: (data, vars) => vars.sub && !data.sub
})

// the lit feed is the default sort: if the user picked new/top from the nav
// tabs, keep them on it (lib/feed-sort.js)
export async function getServerSideProps (ctx) {
  const destination = feedSortRedirect({ req: ctx.req, sub: ctx.query.sub })
  if (destination) return { redirect: { destination, permanent: false } }
  return getSubProps(ctx)
}

export default function Sub ({ ssrData }) {
  const router = useRouter()
  const variables = { ...router.query }
  const { data } = useQuery(SUB_FULL, { variables })

  if (!data && !ssrData) return <PageLoading />
  const { sub } = data || ssrData

  return (
    <Layout sub={sub?.name}>
      {sub && <TerritoryHeader sub={sub} />}
      {!sub && !variables.sub && <FrontpageHeader />}
      <Items ssrData={ssrData} variables={variables} rank />
    </Layout>
  )
}
