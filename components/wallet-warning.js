import { useState } from 'react'
import Link from 'next/link'
import Alert from 'react-bootstrap/Alert'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { useMe } from '@/components/me'

const MY_MONERO_ACCOUNT = gql`
  query MyMoneroAccount {
    myMoneroAccount { id }
  }
`

// Global nudge: logged-in users with no registered Monero wallet cannot receive
// tips on their posts. Dismissed per-session (local state); reappears on reload.
// Shares the MyMoneroAccount cache entry with WalletSetup so registering/
// unregistering a wallet on the settings page hides/shows this immediately.
export default function WalletWarning () {
  const { me } = useMe()
  const [dismissed, setDismissed] = useState(false)
  const { data, loading } = useQuery(MY_MONERO_ACCOUNT, {
    skip: !me
  })

  if (!me || loading || dismissed) return null
  if (data?.myMoneroAccount) return null

  return (
    <Alert
      variant='warning'
      className='text-center mb-0 rounded-0'
      onClose={() => setDismissed(true)}
      dismissible
    >
      you haven't registered a monero wallet — posts you make can't receive tips.{' '}
      <Link href='/settings/wallet'>register a wallet</Link> to start earning.
    </Alert>
  )
}
