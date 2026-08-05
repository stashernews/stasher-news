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
// Rendered client-side only (ssr: false): the SSR render client is cache-only
// and can never resolve this orphan query, so running it on the server would
// flash a false-positive banner in the initial HTML for users WITH a wallet.
// cache-and-network re-verifies against the server on every mount so a stale
// cached null can never pin the banner on, while the register/unregister
// cache writes on the settings page still take effect immediately.
export default function WalletWarning () {
  const { me } = useMe()
  const [dismissed, setDismissed] = useState(false)
  const { data } = useQuery(MY_MONERO_ACCOUNT, {
    skip: !me,
    ssr: false,
    fetchPolicy: 'cache-and-network'
  })

  if (!me || data === undefined || dismissed) return null
  if (data?.myMoneroAccount) return null

  return (
    <Alert
      variant='warning'
      className='text-center mb-0 rounded-0'
      onClose={() => setDismissed(true)}
      dismissible
    >
      you haven't registered a Monero wallet yet. posts you make can't receive tips{' '}
      or weekly rewards. <Link href='/settings/wallet'>register a wallet</Link> to start earning.
    </Alert>
  )
}
