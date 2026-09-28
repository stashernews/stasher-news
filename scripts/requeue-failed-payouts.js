// Recovery tool for stranded rewards payouts (2026-09-28 incident): flips a
// distribution's terminal FAILED payouts (NULL txHash — provably pre-relay,
// never broadcast) back to QUEUED and drives delivery through the normal
// finalize path. Dry-run by default; --confirm mutates.
//
//   dev: sndev monero requeue <id> [--confirm] [--no-send]
//   direct: npx tsx --tsconfig jsconfig.json scripts/requeue-failed-payouts.js <id> [--confirm] [--no-send]
//   VPS: loader-wrapped (see AGENTS.md) — --send (default) needs PLATFORM_REWARDS_*
//   --no-send flips rows only (no wallet open); the next same-week distribution
//   run or another --confirm run delivers them.
import { PrismaClient } from '@prisma/client'
import { requeueFailedPayouts } from '@/worker/rewardsDistributor'

const prisma = new PrismaClient()

function piconerosToXmr (piconeros) {
  return (Number(piconeros) / 1e12).toFixed(6)
}

function parseArgs (argv) {
  const rest = argv.filter(a => !a.startsWith('--'))
  const flags = argv.filter(a => a.startsWith('--'))
  const distributionId = Number(rest[0])
  const known = ['--confirm', '--no-send']
  if (!Number.isInteger(distributionId) || distributionId <= 0 || flags.some(f => !known.includes(f))) {
    console.error('Usage: requeue-failed-payouts <distributionId> [--confirm] [--no-send]')
    console.error('  dry-run by default; --confirm flips FAILED(NULL-txHash) payouts to QUEUED and')
    console.error('  drives delivery (needs wallet env); --no-send flips rows only')
    process.exit(1)
  }
  return { distributionId, confirm: flags.includes('--confirm'), send: !flags.includes('--no-send') }
}

async function main () {
  const { distributionId, confirm, send } = parseArgs(process.argv.slice(2))
  const summary = await requeueFailedPayouts(prisma, distributionId, { confirm, send })
  console.log(`--- distribution ${summary.distributionId} (status ${summary.status}) ---`)
  if (summary.refusedWithTxHash.length > 0) {
    console.log(`  REFUSED (FAILED with txHash — wallet-history reconciliation path, never requeued): ${summary.refusedWithTxHash.join(', ')}`)
  }
  if (summary.candidates.length === 0) {
    const willDrive = confirm && send && summary.queuedCount > 0
    if (!willDrive) {
      console.log(summary.queuedCount > 0
        ? `--- no FAILED rows to requeue; ${summary.queuedCount} QUEUED payout(s) present — nothing to do (${confirm ? '--no-send' : 'dry-run; --confirm drives delivery'}) ---`
        : '--- no requeueable payouts (FAILED with NULL txHash) — nothing to do ---')
      return
    }
    console.log(`--- no FAILED rows to requeue; driving delivery of ${summary.queuedCount} QUEUED payout(s) ---`)
  }
  for (const c of summary.candidates) {
    console.log(`  payout ${c.id}: curator=${c.curatorId} ${c.piconeros.toString()} pico (~${piconerosToXmr(c.piconeros)} XMR) -> ${c.recipientAddress}`)
  }
  if (summary.candidates.length > 0) {
    console.log(`  total: ${summary.candidatePiconeros.toString()} pico (~${piconerosToXmr(summary.candidatePiconeros)} XMR) across ${summary.candidates.length} payout(s)`)
  }
  if (!confirm) {
    console.log('--- dry-run: nothing mutated. Re-run with --confirm to requeue + deliver. ---')
    return
  }
  console.log(`  requeued: ${summary.requeued}`)
  console.log(`  drove delivery: ${summary.drove}`)
  console.log(`  final distribution status: ${summary.finalStatus}`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
