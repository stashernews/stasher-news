import React, { useContext, useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { fixedDecimal } from '@/lib/format'
import { useMe } from './me'
import { PRICE } from '@/fragments/price'
import { CURRENCY_SYMBOLS } from '@/lib/currency'
import { NORMAL_POLL_INTERVAL_MS, SSR } from '@/lib/constants'
import { useBlockHeight } from './block-height'
import { usePriceCarousel } from './nav/price-carousel'

export const PriceContext = React.createContext({
  price: null,
  fiatSymbol: null
})

export function usePrice () {
  return useContext(PriceContext)
}

export function PriceProvider ({ price, children }) {
  const { me } = useMe()
  const fiatCurrency = me?.privates?.fiatCurrency
  const { data } = useQuery(PRICE, {
    variables: { fiatCurrency },
    ...(SSR
      ? {}
      : {
          pollInterval: NORMAL_POLL_INTERVAL_MS,
          nextFetchPolicy: 'cache-and-network'
        })
  })

  const contextValue = useMemo(() => ({
    price: data?.price || price,
    fiatSymbol: CURRENCY_SYMBOLS[fiatCurrency] || '$'
  }), [data?.price, price, me?.privates?.fiatCurrency])

  return (
    <PriceContext.Provider value={contextValue}>
      {children}
    </PriceContext.Provider>
  )
}

function AccessibleButton ({ id, description, children, ...props }) {
  return (
    <div>
      <button {...props} aria-describedby={id}>{children}</button>
      <div id={id} className='visually-hidden'>{description}</div>
    </div>
  )
}

// Stasher News price carousel: XMR fiat price, XMR-per-fiat inverse, and the
// monerod block height. The BTC-era modes (1sat=1sat, sat/vB chain fee, halving
// countdown) are gone — Monero has no discrete halving and no Lightning fee rate.
export default function Price ({ className }) {
  const [selection, handleClick] = usePriceCarousel()

  const { price, fiatSymbol } = usePrice()
  const { height: blockHeight } = useBlockHeight()

  const compClassName = (className || '') + ' text-reset pointer'

  if (selection === 'fiat') {
    if (!price || price < 0) return null
    return (
      <AccessibleButton id='fiat-hint' description='Show XMR per fiat unit' className={compClassName} onClick={handleClick} variant='link'>
        {fiatSymbol + fixedDecimal(price, 2)}
      </AccessibleButton>
    )
  }

  if (selection === 'yep') {
    if (!price || price < 0) return null
    return (
      <AccessibleButton id='yep-hint' description='Show fiat price' className={compClassName} onClick={handleClick} variant='link'>
        {fixedDecimal(1 / price, 4) + ` XMR/${fiatSymbol}`}
      </AccessibleButton>
    )
  }

  if (selection === 'blockHeight') {
    if (blockHeight <= 0) return null
    return (
      <AccessibleButton id='blockHeight-hint' description='Show fiat price' className={compClassName} onClick={handleClick} variant='link'>
        {blockHeight}
      </AccessibleButton>
    )
  }
}
