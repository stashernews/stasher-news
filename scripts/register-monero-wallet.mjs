#!/usr/bin/env node
// Dev-only: register a MoneroAccount for a test user (by nym) so they can RECEIVE tips.
// Mirrors Mutation.registerMoneroAccount without the GraphQL/auth layer.
//   usage: node scripts/register-monero-wallet.mjs <nym> <address> <viewKey>
import { MoneroUtils, MoneroNetworkType } from 'monero-ts'
import { encryptViewKey } from '../api/monero/viewkey.js'
import { lwsClient } from '../api/monero/lwsClient.js'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const NET = (process.env.MONERO_NETWORK || 'stagenet').toUpperCase()

async function main () {
  const [, , nym, address, viewKey] = process.argv
  if (!nym || !address || !viewKey) {
    console.error('usage: node scripts/register-monero-wallet.mjs <nym> <address> <viewKey>')
    process.exit(1)
  }
  const user = await prisma.user.findUnique({ where: { name: nym } })
  if (!user) throw new Error(`no user with nym ${nym}`)

  const netType = MoneroNetworkType[NET]
  if (!await MoneroUtils.isValidAddress(address, netType)) {
    throw new Error(`invalid Monero address for ${NET}`)
  }
  if (!await MoneroUtils.isValidPrivateViewKey(viewKey)) {
    throw new Error('invalid Monero private view key')
  }

  // lws FIRST (plaintext view key over TLS), then persist (atomic).
  await lwsClient.addAccount(address, viewKey)

  const account = await prisma.$transaction(async (tx) => {
    const acc = await tx.moneroAccount.create({
      data: {
        ownerUserId: user.id,
        address,
        label: 'author',
        network: NET,
        status: 'ACTIVE',
        lwsRegisteredAt: new Date()
      }
    })
    await tx.moneroViewKey.create({ data: { accountId: acc.id, ...encryptViewKey(viewKey) } })
    return acc
  })
  console.log(`registered MoneroAccount #${account.id} for ${nym} (${address})`)
  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
