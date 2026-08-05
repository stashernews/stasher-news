import Layout from '@/components/layout'
import { getGetServerSideProps } from '@/api/ssrApollo'
import { SettingsHeader } from './index'
import WalletSetup from '@/components/wallet-setup'
import Alert from 'react-bootstrap/Alert'

// Stasher News author wallet onboarding (spec §8.2). SSR-only shell; the
// WalletSetup component handles the query for an existing account and the
// AUTO_INDEX registration flow client-side.
export const getServerSideProps = getGetServerSideProps({ authRequired: true })

function WalletDisclaimer () {
  return (
    <Alert variant='warning' className='mb-3'>
      <h6 className='alert-heading'>before you register a wallet</h6>
      <p className='mb-2'>
        create a <strong>new wallet solely for use with Stasher News</strong>{' '}
        rather than reusing one you already use elsewhere.
      </p>
      <p className='mb-0'>
        pasting your private view key gives Stasher News permission to see all
        incoming transfers to that wallet — including tips on your posts and any
        other transactions sent to it. the view key cannot spend your funds, but
        it does reveal your incoming activity.
      </p>
    </Alert>
  )
}

export default function WalletSettingsPage () {
  return (
    <Layout>
      <div className='pb-3 w-100 mt-2' style={{ maxWidth: '600px' }}>
        <SettingsHeader />
        <h3 className='mb-3 text-start'>monero wallet</h3>
        <WalletDisclaimer />
        <WalletSetup />
      </div>
    </Layout>
  )
}
