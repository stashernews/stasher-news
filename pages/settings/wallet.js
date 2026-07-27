import Layout from '@/components/layout'
import { getGetServerSideProps } from '@/api/ssrApollo'
import { SettingsHeader } from './index'
import WalletSetup from '@/components/wallet-setup'

// StealthNews author wallet onboarding (spec §8.2). SSR-only shell; the
// WalletSetup component handles the query for an existing account and the
// AUTO_INDEX registration flow client-side.
export const getServerSideProps = getGetServerSideProps({ authRequired: true })

export default function WalletSettingsPage () {
  return (
    <Layout>
      <div className='pb-3 w-100 mt-2' style={{ maxWidth: '600px' }}>
        <SettingsHeader />
        <h3 className='mb-3 text-start'>monero wallet</h3>
        <WalletSetup />
      </div>
    </Layout>
  )
}
