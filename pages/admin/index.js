import Head from 'next/head'
import { AdminPanel } from '@/components/admin/panel'

export default function AdminPage () {
  return <><Head><title>Admin · Stasher News</title><meta name='robots' content='noindex,nofollow' /></Head><AdminPanel /></>
}

AdminPage.adminPage = true

export async function getServerSideProps ({ req, res }) {
  res.setHeader('Cache-Control', 'no-store')
  const { isAdminRequest } = await import('@/lib/admin/guard')
  return isAdminRequest(req) ? { props: {} } : { notFound: true }
}
