import { createContext, useContext, useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { NORMAL_POLL_INTERVAL_MS, SSR } from '@/lib/constants'
import { BLOCK_HEIGHT } from '@/fragments/blockHeight'

export const BlockHeightContext = createContext({
  height: 0
})

export const useBlockHeight = () => useContext(BlockHeightContext)

// Monero has no discrete halving (smooth tail emission), so this provider
// surfaces only the monerod chain height. The BTC halving countdown is gone.
export const BlockHeightProvider = ({ blockHeight, children }) => {
  const { data } = useQuery(BLOCK_HEIGHT, {
    ...(SSR
      ? {}
      : {
          pollInterval: NORMAL_POLL_INTERVAL_MS,
          nextFetchPolicy: 'cache-and-network'
        })
  })
  const value = useMemo(() => ({
    height: data?.blockHeight ?? blockHeight ?? 0
  }), [data?.blockHeight, blockHeight])
  return (
    <BlockHeightContext.Provider value={value}>
      {children}
    </BlockHeightContext.Provider>
  )
}
