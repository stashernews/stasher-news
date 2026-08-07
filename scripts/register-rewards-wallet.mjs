// Register the platform rewards wallet with monero-lws + persist its MoneroAccount
// row + encrypted view key. Run ONCE per network at setup:
//
//   sndev monero register-rewards-wallet
//
// Env (set in .env.local — never commit real keys):
//   PLATFORM_REWARDS_ADDRESS  base58 primary address (95 chars)
//   PLATFORM_REWARDS_VIEW_KEY private view key (64 hex)
//   PLATFORM_REWARDS_SPEND_KEY private spend key (ONLY for derive-fee-pool, not here)
//   REWARDS_SCAN_FROM_HEIGHT  optional rescan height (default 0)
//   MONERO_NETWORK            stagenet | mainnet
//   VIEWKEY_MASTER_KEY        envelope master key (already required by the app)
//
// The spend key is NEVER read by this script — only by derive-rewards-fee-subaddresses.js.
import { PrismaClient } from '@prisma/client'
import { lwsClient } from '../api/monero/lwsClient.js'
import { encryptViewKey } from '../api/monero/viewkey.js'

const prisma = new PrismaClient()

async function main () {
  const address = process.env.PLATFORM_REWARDS_ADDRESS
  const viewKey = process.env.PLATFORM_REWARDS_VIEW_KEY
  const network = (process.env.MONERO_NETWORK || 'stagenet').toUpperCase()
  if (!address || !viewKey) {
    throw new Error('PLATFORM_REWARDS_ADDRESS and PLATFORM_REWARDS_VIEW_KEY must be set')
  }

  // lws FIRST (idempotent on lws 0.3): an lws failure leaves nothing locally.
  console.log(`registering rewards wallet ${address} with lws (${network})...`)
  await lwsClient.addAccount(address, viewKey)

  // persist the MoneroAccount row (idempotent on [address, network]).
  // update must ALSO set label/scanFromHeight: if an 'author' row already
  // exists for this address, the create branch is skipped and the label would
  // otherwise stay 'author', leaving no platform_rewards row for
  // getRewardsWalletId/rewardsWalletObserver to find.
  const pending = await prisma.moneroAccount.findFirst({
    where: { address, network },
    select: { id: true, label: true }
  })
  if (pending && pending.label !== 'platform_rewards') {
    throw new Error(
      'refusing to reclassify an existing ' + pending.label + ' MoneroAccount ' +
      '(id=' + pending.id + ', ' + address + ') as the rewards wallet. ' +
      'Use a dedicated rewards address, or set the row label to platform_rewards ' +
      'manually if this is intended.'
    )
  }
  const account = await prisma.moneroAccount.upsert({
    where: { address_network: { address, network } },
    create: {
      label: 'platform_rewards',
      address,
      network,
      status: 'ACTIVE',
      scanFromHeight: BigInt(process.env.REWARDS_SCAN_FROM_HEIGHT || 0)
    },
    update: { status: 'ACTIVE', label: 'platform_rewards' }
  })

  // store the encrypted view key (idempotent — one envelope per account)
  const existingVk = await prisma.moneroViewKey.findUnique({ where: { accountId: account.id } })
  if (!existingVk) {
    await prisma.moneroViewKey.create({ data: { accountId: account.id, ...encryptViewKey(viewKey) } })
    console.log('stored encrypted rewards view key')
  }

  console.log(`platform_rewards wallet registered (MoneroAccount id=${account.id})`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
