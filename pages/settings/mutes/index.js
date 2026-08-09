import { useMemo } from 'react'
import { getGetServerSideProps } from '@/api/ssrApollo'
import Layout from '@/components/layout'
import UserList from '@/components/user-list'
import { MY_MUTED_USERS } from '@/fragments/users'
import { SettingsHeader } from '../index'
import { MuteUserContextProvider } from '@/components/mute'
import { COPY } from '@/lib/rebrand-copy'

export const getServerSideProps = getGetServerSideProps({ query: MY_MUTED_USERS, authRequired: true })

export default function MyMutedUsers ({ ssrData }) {
  const muteUserContextValue = useMemo(() => ({ refetchQueries: ['MyMutedUsers'] }), [])
  return (
    <Layout>
      <div className='pb-3 w-100 mt-2'>
        <SettingsHeader />
        <div className='mb-4 text-muted'>{COPY.mutesHeader}</div>
        <MuteUserContextProvider value={muteUserContextValue}>
          <UserList
            ssrData={ssrData} query={MY_MUTED_USERS}
            destructureData={data => data.myMutedUsers}
            variables={{}}
            rank
            nymActionDropdown
            statCompsProp={[]}
          />
        </MuteUserContextProvider>
      </div>
    </Layout>
  )
}
