// Derive fee subaddresses for the platform rewards wallet OFFLINE and register
// the index ranges with monero-lws. Run at setup and whenever the pool runs low:
//
//   sndev monero derive-fee-pool
//
// This is the ONLY manual process that loads the rewards SPEND key. It derives
// subaddresses for account index 1 (posting fees) and 2 (territory fees) using a
// keys-only wallet (no daemon connection), upserts them as SubaddressIndex rows,
// and tells lws to scan those index ranges (view-key auth only).
//
// Env:
//   PLATFORM_REWARDS_ADDRESS / PLATFORM_REWARDS_VIEW_KEY / PLATFORM_REWARDS_SPEND_KEY
//   POSTING_FEE_POOL_SIZE   default 2000
//   TERRITORY_FEE_POOL_SIZE default 200
//   MONERO_NETWORK          stagenet | mainnet
//
// The derivation logic lives in api/monero/feePoolDerive.js, shared with the
// worker's automatic pool top-up (penaltyIndexer).
import { PrismaClient } from '@prisma/client'
import { deriveFeePoolAll } from '../api/monero/feePoolDerive.js'

const prisma = new PrismaClient()

async function main () {
  const results = await deriveFeePoolAll(prisma)
  for (const { major, added } of results) {
    console.log(`derived + registered ${added} subaddresses at rewards-wallet account index ${major}`)
  }
  console.log('fee pool derivation complete')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
