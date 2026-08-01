// Manually trigger one weekly rewards distribution run (dev/operator trigger):
//
//   sndev monero distribute
//
// Imports runDistributionOnce (the testable core, no pg-boss) and prints the
// resulting RewardDistribution + its QUEUED RewardPayout rows. This is the
// non-cron path for running a distribution out of band. Task 9's hot-wallet
// signer is what actually sends the QUEUED payouts on-chain; this script only
// earmarks the pool and creates the payout ledger.
//
// This is a .js (not .mjs) entry run via `tsx --tsconfig jsconfig.json`, mirroring
// worker/index.js: the rewardsDistributor module imports the `@/` alias, which
// plain node / strict-ESM .mjs can't resolve. tsx + a .js entry resolves `@/` and
// exposes the module's named ESM exports correctly.
import { PrismaClient } from '@prisma/client'
import { runDistributionOnce } from '@/worker/rewardsDistributor'

const prisma = new PrismaClient()

function piconerosToXmr (piconeros) {
  return (Number(piconeros) / 1e12).toFixed(6)
}

async function main () {
  const dist = await runDistributionOnce({ models: prisma })

  console.log('--- RewardDistribution ---')
  console.log(`  id                   : ${dist.id}`)
  console.log(`  period               : ${dist.periodStart.toISOString()} -> ${dist.periodEnd.toISOString()}`)
  console.log(`  status               : ${dist.status}`)
  console.log(`  poolPiconeros        : ${dist.poolPiconeros.toString()}  (~${piconerosToXmr(dist.poolPiconeros)} XMR)`)
  console.log(`  distributedPiconeros : ${dist.distributedPiconeros.toString()}  (~${piconerosToXmr(dist.distributedPiconeros)} XMR)`)
  console.log(`  rolledOverPiconeros  : ${dist.rolledOverPiconeros.toString()}  (~${piconerosToXmr(dist.rolledOverPiconeros)} XMR)`)
  console.log(`  payoutCount          : ${dist.payoutCount}`)

  const payouts = dist.payouts || await prisma.rewardPayout.findMany({ where: { distributionId: dist.id } })
  if (payouts.length > 0) {
    console.log(`--- ${payouts.length} QUEUED RewardPayout(s) (Task 9 sends these) ---`)
    for (const p of payouts) {
      console.log(`  curator=${p.curatorId} state=${p.state} ${p.piconeros.toString()} pico (~${piconerosToXmr(p.piconeros)} XMR) -> ${p.recipientAddress}`)
    }
  } else {
    console.log('--- no RewardPayout rows (pool fully rolled over) ---')
  }
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
