// Derive fee subaddresses for the platform rewards wallet OFFLINE and register
// the index ranges with monero-lws. Run at setup and whenever the pool runs low:
//
//   sndev monero derive-fee-pool
//
// This is the ONLY process that loads the rewards SPEND key. It derives
// subaddresses for account index 1 (posting fees) and 2 (territory fees) using a
// keys-only wallet (no daemon connection), upserts them as SubaddressIndex rows,
// and tells lws to scan those index ranges (view-key auth only).
//
// Env:
//   PLATFORM_REWARDS_ADDRESS / PLATFORM_REWARDS_VIEW_KEY / PLATFORM_REWARDS_SPEND_KEY
//   POSTING_FEE_POOL_SIZE   default 2000
//   TERRITORY_FEE_POOL_SIZE default 200
//   MONERO_NETWORK          stagenet | mainnet
import moneroTs from 'monero-ts'
import { PrismaClient } from '@prisma/client'
import { lwsClient } from '../api/monero/lwsClient.js'

const prisma = new PrismaClient()

const REWARDS_POSTING_MAJOR = 1
const REWARDS_TERRITORY_MAJOR = 2

async function main () {
  const address = process.env.PLATFORM_REWARDS_ADDRESS
  const viewKey = process.env.PLATFORM_REWARDS_VIEW_KEY
  const spendKey = process.env.PLATFORM_REWARDS_SPEND_KEY
  if (!address || !viewKey || !spendKey) {
    throw new Error('PLATFORM_REWARDS_ADDRESS, PLATFORM_REWARDS_VIEW_KEY, and PLATFORM_REWARDS_SPEND_KEY must be set')
  }
  const networkEnv = (process.env.MONERO_NETWORK || 'stagenet').toLowerCase()
  const net = networkEnv === 'mainnet' ? moneroTs.MoneroNetworkType.MAINNET : moneroTs.MoneroNetworkType.STAGENET

  // keys-only wallet — offline derivation, no daemon RPC
  const wallet = await moneroTs.createWalletKeys({
    networkType: net,
    password: 'derive-only',
    primaryAddress: address,
    privateViewKey: viewKey,
    privateSpendKey: spendKey
  })

  const account = await prisma.moneroAccount.findFirst({ where: { label: 'platform_rewards' } })
  if (!account) throw new Error('platform_rewards MoneroAccount not registered yet; run sndev monero register-rewards-wallet first')

  const plans = [
    { major: REWARDS_POSTING_MAJOR, count: Number(process.env.POSTING_FEE_POOL_SIZE || 2000) },
    { major: REWARDS_TERRITORY_MAJOR, count: Number(process.env.TERRITORY_FEE_POOL_SIZE || 200) }
  ]

  for (const { major, count } of plans) {
    for (let minor = 1; minor <= count; minor++) {
      const subAddress = await wallet.getSubaddress(major, minor)
      await prisma.subaddressIndex.upsert({
        where: { accountId_majorIndex_minorIndex: { accountId: account.id, majorIndex: major, minorIndex: minor } },
        create: { accountId: account.id, majorIndex: major, minorIndex: minor, address: subAddress, state: 'AVAILABLE' },
        update: {}
      })
    }
    // tell lws to scan this account's [1, count] index range (view-key auth)
    await lwsClient.upsertSubaddrs(account, { [String(major)]: [[1, count]] })
    console.log(`derived + registered ${count} subaddresses at rewards-wallet account index ${major}`)
  }

  console.log('fee pool derivation complete')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
