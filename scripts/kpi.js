const { ApolloClient, InMemoryCache, HttpLink, gql } = require('@apollo/client')
const fetch = require('cross-fetch')

// Configuration
const GRAPHQL_ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'http://localhost:3000/api/graphql'
const PLAUSIBLE_API_KEY = process.env.PLAUSIBLE_API_KEY

// Apollo Client setup
const client = new ApolloClient({
  link: new HttpLink({
    uri: GRAPHQL_ENDPOINT,
    fetch
  }),
  cache: new InMemoryCache(),
  defaultOptions: {
    query: {
      fetchPolicy: 'no-cache'
    }
  }
})

// GraphQL queries - using when=year gives monthly time buckets
const GROWTH_QUERY = gql`
  query Growth($when: String!, $sub: String) {
    registrationGrowth(when: $when) {
      time
      data {
        name
        value
      }
    }
    spendingGrowth(when: $when, sub: $sub) {
      time
      data {
        name
        value
      }
    }
    stashingGrowth(when: $when, sub: $sub) {
      time
      data {
        name
        value
      }
    }
    spenderGrowth(when: $when, sub: $sub) {
      time
      data {
        name
        value
      }
    }
  }
`

// Turf fee types that count as SN platform revenue (founders earn no share; fees fund rewards pool + ops)
const TERRITORY_REVENUE_TYPES = ['TERRITORY_BILLING', 'TERRITORY_CREATE', 'TERRITORY_UPDATE', 'TERRITORY_UNARCHIVE']

// Utility functions
function formatNumber (num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'm'
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'k'
  }
  return num.toString()
}

function formatXmr (piconeros) {
  const n = piconeros / 1e12
  const str = n % 1 === 0 ? Number(n).toString() : Number(n).toFixed(12).replace(/0+$/, '').replace(/\.$/, '')
  return formatNumber(str) + ' XMR'
}

function calculatePercentChange (current, previous) {
  if (previous === 0) return current > 0 ? '+∞' : '0%'
  const change = ((current - previous) / previous) * 100
  const sign = change >= 0 ? '+' : ''
  return `${sign}${change.toFixed(1)}%`
}

function formatMonth (monthStr) {
  // monthStr format: "2025-07"
  const [year, month] = monthStr.split('-')
  const monthNames = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
  ]
  return `${monthNames[parseInt(month) - 1]} ${year}`
}

// Convert a time bucket date to month string "YYYY-MM"
function timeToMonth (time) {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

// Get the list of complete months to display
function getMonthsToDisplay (monthsBack) {
  const months = []
  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth() // 0-indexed

  // Start from the previous month (most recent complete month)
  // and go back monthsBack months, plus 1 extra for comparison
  for (let i = 0; i < monthsBack + 1; i++) {
    let targetMonth = currentMonth - 1 - i
    let targetYear = currentYear

    while (targetMonth < 0) {
      targetMonth += 12
      targetYear -= 1
    }

    const monthStr = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}`
    months.unshift(monthStr) // Add to beginning to keep chronological order
  }

  return months
}

// Get date range for a month (used for territory profits and Plausible)
function getMonthDateRange (monthStr) {
  const [year, month] = monthStr.split('-').map(Number)
  const startDate = new Date(year, month - 1, 1)
  const endDate = new Date(year, month, 0, 23, 59, 59, 999)
  return {
    from: startDate.getTime().toString(),
    to: endDate.getTime().toString(),
    startDateStr: startDate.toISOString().slice(0, 10),
    endDateStr: endDate.toISOString().slice(0, 10)
  }
}

// Sum values for specific types from a data entry
function sumDataValues (dataArray, types = null) {
  if (!dataArray) return 0
  return dataArray
    .filter(d => types === null || types.includes(d.name))
    .reduce((sum, d) => sum + (d.value || 0), 0)
}

// Get the 'total' value from a data entry (unique count)
function getTotalValue (dataArray) {
  if (!dataArray) return 0
  const total = dataArray.find(d => d.name === 'total')
  return total?.value || 0
}

async function generateKPISummary (monthsBack = 6) {
  try {
    console.log(`\n# Stasher News KPI Summary (Last ${monthsBack} months)\n`)

    const now = new Date()
    console.log('Current date:', now.toISOString().slice(0, 10))
    console.log('Endpoint:', GRAPHQL_ENDPOINT)

    // Get the months we want to display (complete months only)
    const months = getMonthsToDisplay(monthsBack)
    console.log('Months to display:', months)

    // Query with when=year to get monthly time buckets
    console.log('Querying growth data with when=year...')
    const { data } = await client.query({
      query: GROWTH_QUERY,
      variables: {
        when: 'year',
        sub: 'all'
      }
    })

    // Build a map of monthly data from the time series responses
    const monthlyDataMap = {}

    // Process registration data
    if (data.registrationGrowth) {
      for (const entry of data.registrationGrowth) {
        const month = timeToMonth(entry.time)
        if (!monthlyDataMap[month]) monthlyDataMap[month] = {}
        monthlyDataMap[month].registrations = sumDataValues(entry.data)
      }
    }

    // Process spending data
    if (data.spendingGrowth) {
      for (const entry of data.spendingGrowth) {
        const month = timeToMonth(entry.time)
        if (!monthlyDataMap[month]) monthlyDataMap[month] = {}
        monthlyDataMap[month].spending = sumDataValues(entry.data)
        monthlyDataMap[month].territoryRevenue = sumDataValues(entry.data, TERRITORY_REVENUE_TYPES)
      }
    }

    // Process stashing data
    if (data.stashingGrowth) {
      for (const entry of data.stashingGrowth) {
        const month = timeToMonth(entry.time)
        if (!monthlyDataMap[month]) monthlyDataMap[month] = {}
        monthlyDataMap[month].stashing = sumDataValues(entry.data)
      }
    }

    // Process unique spenders - each monthly bucket already has the correct unique count
    if (data.spenderGrowth) {
      for (const entry of data.spenderGrowth) {
        const month = timeToMonth(entry.time)
        if (!monthlyDataMap[month]) monthlyDataMap[month] = {}
        monthlyDataMap[month].uniqueSpenders = getTotalValue(entry.data)
      }
    }

    // Convert map to array for the months we want to display
    const monthlyData = months.map(month => ({
      month,
      spending: monthlyDataMap[month]?.spending ?? 'N/A',
      stashing: monthlyDataMap[month]?.stashing ?? 'N/A',
      registrations: monthlyDataMap[month]?.registrations ?? 'N/A',
      territoryRevenue: monthlyDataMap[month]?.territoryRevenue ?? 'N/A',
      uniqueSpenders: monthlyDataMap[month]?.uniqueSpenders ?? 'N/A'
    }))

    // Get Plausible data for each month
    const plausibleData = []

    for (const month of months) {
      const { startDateStr, endDateStr } = getMonthDateRange(month)
      const dateRange = `${startDateStr},${endDateStr}`

      console.log(`Querying Plausible for ${month}: ${dateRange}`)

      try {
        // Get pageviews
        const pvResponse = await fetch(
          `https://plausible.io/api/v1/stats/timeseries?site_id=stasher.news&period=custom&date=${dateRange}&interval=month&metrics=pageviews`,
          {
            headers: { Authorization: `Bearer ${PLAUSIBLE_API_KEY}` }
          }
        )
        const pvData = await pvResponse.json()
        const pageviews = pvData.results?.[0]?.pageviews || 'N/A'

        // Get visitors
        const vResponse = await fetch(
          `https://plausible.io/api/v1/stats/timeseries?site_id=stasher.news&period=custom&date=${dateRange}&interval=month&metrics=visitors`,
          {
            headers: { Authorization: `Bearer ${PLAUSIBLE_API_KEY}` }
          }
        )
        const vData = await vResponse.json()
        const visitors = vData.results?.[0]?.visitors || 'N/A'

        plausibleData.push({ month, pageviews, visitors })
      } catch (error) {
        console.warn(`Failed to fetch Plausible data for ${month}:`, error.message)
        plausibleData.push({ month, pageviews: 'N/A', visitors: 'N/A' })
      }
    }

    // Display results (skip first month, it's just for comparison)
    console.log('\n## Registrations:')
    for (let i = 1; i < monthlyData.length; i++) {
      const current = monthlyData[i]
      const previous = monthlyData[i - 1]
      const change = current.registrations !== 'N/A' && previous.registrations !== 'N/A'
        ? ` (${calculatePercentChange(current.registrations, previous.registrations)})`
        : ''
      const value = current.registrations === 'N/A' ? 'N/A' : current.registrations
      console.log(`${formatMonth(current.month)}: ${value}${change}`)
    }

    console.log('\n## Unique Visitors:')
    for (let i = 1; i < plausibleData.length; i++) {
      const current = plausibleData[i]
      const previous = plausibleData[i - 1]
      const change = current.visitors !== 'N/A' && previous.visitors !== 'N/A'
        ? ` (${calculatePercentChange(current.visitors, previous.visitors)})`
        : ''
      const value = current.visitors === 'N/A' ? 'N/A' : formatNumber(current.visitors)
      console.log(`${formatMonth(current.month)}: ${value}${change}`)
    }

    console.log('\n## Page Views:')
    for (let i = 1; i < plausibleData.length; i++) {
      const current = plausibleData[i]
      const previous = plausibleData[i - 1]
      const change = current.pageviews !== 'N/A' && previous.pageviews !== 'N/A'
        ? ` (${calculatePercentChange(current.pageviews, previous.pageviews)})`
        : ''
      const value = current.pageviews === 'N/A' ? 'N/A' : formatNumber(current.pageviews)
      console.log(`${formatMonth(current.month)}: ${value}${change}`)
    }

    console.log('\n## Unique Spenders:')
    for (let i = 1; i < monthlyData.length; i++) {
      const current = monthlyData[i]
      const previous = monthlyData[i - 1]
      const change = current.uniqueSpenders !== 'N/A' && previous.uniqueSpenders !== 'N/A'
        ? ` (${calculatePercentChange(current.uniqueSpenders, previous.uniqueSpenders)})`
        : ''
      const value = current.uniqueSpenders === 'N/A' ? 'N/A' : formatNumber(current.uniqueSpenders)
      console.log(`${formatMonth(current.month)}: ${value}${change}`)
    }

    console.log('\n## Total Spending:')
    for (let i = 1; i < monthlyData.length; i++) {
      const current = monthlyData[i]
      const previous = monthlyData[i - 1]
      const change = current.spending !== 'N/A' && previous.spending !== 'N/A'
        ? ` (${calculatePercentChange(current.spending, previous.spending)})`
        : ''
      const value = current.spending === 'N/A' ? 'N/A' : formatXmr(current.spending)
      console.log(`${formatMonth(current.month)}: ${value}${change}`)
    }

    console.log('\n## Total Stashing:')
    for (let i = 1; i < monthlyData.length; i++) {
      const current = monthlyData[i]
      const previous = monthlyData[i - 1]
      const change = current.stashing !== 'N/A' && previous.stashing !== 'N/A'
        ? ` (${calculatePercentChange(current.stashing, previous.stashing)})`
        : ''
      const value = current.stashing === 'N/A' ? 'N/A' : formatXmr(current.stashing)
      console.log(`${formatMonth(current.month)}: ${value}${change}`)
    }

    console.log('\n## Turf Revenue (SN earnings):')
    for (let i = 1; i < monthlyData.length; i++) {
      const current = monthlyData[i]
      const previous = monthlyData[i - 1]
      const change = current.territoryRevenue !== 'N/A' && previous.territoryRevenue !== 'N/A'
        ? ` (${calculatePercentChange(current.territoryRevenue, previous.territoryRevenue)})`
        : ''
      const value = current.territoryRevenue === 'N/A' ? 'N/A' : formatXmr(current.territoryRevenue)
      console.log(`${formatMonth(current.month)}: ${value}${change}`)
    }

    console.log('\n---')
    if (!PLAUSIBLE_API_KEY) {
      console.log('Note: Set PLAUSIBLE_API_KEY environment variable to fetch page views and visitor data.')
    }
    console.log('Usage: GRAPHQL_ENDPOINT=url PLAUSIBLE_API_KEY=key node scripts/kpi.js [months]\n')
  } catch (error) {
    console.error('Error generating KPI summary:', error)
    process.exit(1)
  }
}

// CLI interface
const args = process.argv.slice(2)
const monthsBack = args[0] ? parseInt(args[0]) : 6

if (isNaN(monthsBack) || monthsBack < 1) {
  console.error('Usage: node scripts/kpi.js [months_back]')
  console.error('Example: node scripts/kpi.js 12  # for last 12 months')
  console.error('Example: GRAPHQL_ENDPOINT=https://stasher.news/api/graphql PLAUSIBLE_API_KEY=key node scripts/kpi.js 6')
  process.exit(1)
}

generateKPISummary(monthsBack).catch(console.error)
