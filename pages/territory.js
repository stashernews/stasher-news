import Link from 'next/link'
import { getGetServerSideProps } from '@/api/ssrApollo'
import { CenterLayout } from '@/components/layout'
import TerritoryForm from '@/components/territory-form'

export const getServerSideProps = getGetServerSideProps({ authRequired: true })

export default function TerritoryPage () {
  return (
    <CenterLayout>
      <div className='text-center'>
        <h1 className='mt-5'>Found a Turf</h1>
        <Link className='text-muted' href='/faq#turfs'>learn about turfs</Link>
      </div>
      <TerritoryForm />
    </CenterLayout>
  )
}
