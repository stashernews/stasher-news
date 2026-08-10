// Register the platform bounty escrow wallet with monero-lws + persist its
// MoneroAccount row + encrypted view key. Run ONCE per network at setup:
//
//   sndev monero register-bounty-escrow-wallet
//
// Env (set in .env.local — never commit real keys):
//   BOUNTY_ESCROW_ADDRESS         base58 primary address (95 chars)
//   BOUNTY_ESCROW_VIEW_KEY        private view key (64 hex)
//   BOUNTY_ESCROW_SPEND_KEY       private spend key (ONLY for api/monero/bounties.js, not here)
//   BOUNTY_ESCROW_SCAN_FROM_HEIGHT optional rescan height (default 0)
//   MONERO_NETWORK                stagenet | mainnet
//   VIEWKEY_MASTER_KEY            envelope master key (already required by the app)
//
// The spend key is NEVER read by this script — only by the bounty escrow
// signer (api/monero/bounties.js, worker process).
import { PrismaClient } from '@prisma/client'
import { lwsClient } from '../api/monero/lwsClient.js'
import { encryptViewKey } from '../api/monero/viewkey.js'

const prisma = new PrismaClient()

async function main () {
  const address = process.env.BOUNTY_ESCROW_ADDRESS
  const viewKey = process.env.BOUNTY_ESCROW_VIEW_KEY
  const network = (process.env.MONERO_NETWORK || 'stagenet').toUpperCase()
  if (!address || !viewKey) {
    throw new Error('BOUNTY_ESCROW_ADDRESS and BOUNTY_ESCROW_VIEW_KEY must be set')
  }

  // lws FIRST (idempotent on lws 0.3): an lws failure leaves nothing locally.
  console.log(`registering bounty escrow wallet ${address} with lws (${network})...`)
  await lwsClient.addAccount(address, viewKey)

  // persist the MoneroAccount row (idempotent on [address, network]).
  // update must ALSO set label/scanFromHeight: if an 'author' row already
  // exists for this address, the create branch is skipped and the label would
  // otherwise stay 'author', leaving no bounty_escrow row for the bounties
  // worker to find.
  const pending = await prisma.moneroAccount.findFirst({
    where: { address, network },
    select: { id: true, label: true }
  })
  if (pending && pending.label !== 'bounty_escrow') {
    throw new Error(
      'refusing to reclassify an existing ' + pending.label + ' MoneroAccount ' +
      '(id=' + pending.id + ', ' + address + ') as the bounty escrow wallet. ' +
      'Use a dedicated escrow address, or set the row label to bounty_escrow ' +
      'manually if this is intended.'
    )
  }
  const account = await prisma.moneroAccount.upsert({
    where: { address_network: { address, network } },
    create: {
      label: 'bounty_escrow',
      address,
      network,
      status: 'ACTIVE',
      scanFromHeight: BigInt(process.env.BOUNTY_ESCROW_SCAN_FROM_HEIGHT || 0)
    },
    update: { status: 'ACTIVE', label: 'bounty_escrow' }
  })

  // store the encrypted view key (idempotent — one envelope per account)
  const existingVk = await prisma.moneroViewKey.findUnique({ where: { accountId: account.id } })
  if (!existingVk) {
    await prisma.moneroViewKey.create({ data: { accountId: account.id, ...encryptViewKey(viewKey) } })
    console.log('stored encrypted bounty escrow view key')
  }

  console.log(`bounty_escrow wallet registered (MoneroAccount id=${account.id})`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
