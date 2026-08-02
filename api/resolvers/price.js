import { SUPPORTED_CURRENCIES } from '@/lib/currency'
import { cachedFetcher, snFetch } from '@/lib/fetch'

const getPrice = cachedFetcher(async function fetchPrice (fiat = 'USD') {
  const vs = fiat.toLowerCase()
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=${vs}`
  try {
    const res = await snFetch(url)
    const body = await res.json()
    const p = body?.monero?.[vs]
    return p == null ? -1 : parseFloat(p)
  } catch (err) {
    console.error(err)
    return -1
  }
}, {
  maxSize: SUPPORTED_CURRENCIES.length,
  cacheExpiry: 60 * 1000, // 1 minute
  forceRefreshThreshold: 0, // never force refresh
  keyGenerator: (fiat = 'USD') => fiat
})

export default {
  Query: {
    price: async (parent, { fiatCurrency }, ctx) => {
      return await getPrice(fiatCurrency) || -1
    }
  }
}
