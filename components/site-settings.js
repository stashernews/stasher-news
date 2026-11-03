import { createContext, useContext, useEffect } from 'react'
import { useApolloClient, useQuery } from '@apollo/client/react'
import { SITE_SETTINGS } from '@/fragments/siteSettings'

const SiteSettingsContext = createContext(null)

export function SiteSettingsProvider ({ settings, children }) {
  const client = useApolloClient()
  useEffect(() => {
    if (settings) client.writeQuery({ query: SITE_SETTINGS, data: { siteSettings: settings } })
  }, [client, settings])
  return <SiteSettingsContext.Provider value={settings}>{children}</SiteSettingsContext.Provider>
}

// SSR supplies the first render; subsequent reads share Apollo's session cache.
export function useSiteSettings () {
  const initial = useContext(SiteSettingsContext)
  const { data } = useQuery(SITE_SETTINGS, { skip: initial != null })
  return initial ?? data?.siteSettings
}
