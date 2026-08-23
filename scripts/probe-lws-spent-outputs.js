// One-shot diagnostic: prove the lws get_address_txs wire shape actually
// carries subaddress indices on spent_outputs — the field api/monero/selfTip.js
// (isSelfSend) depends on for self-send detection. Reports every DISTINCT
// key-shape it finds so an unexpected lws version is visible immediately.
//
//   docker compose exec -T -u apprunner app npx tsx --tsconfig jsconfig.json scripts/probe-lws-spent-outputs.js
//
// Verdicts:
//   SUPPORTED        flat {maj_i,min_i}, nested recipient.{maj_i,min_i}, or nested
//                    sender.{maj_i,min_i} (dev lws 2026-08-23 shape) seen — ship it
//   NO-SPENT-OUTPUTS no scanned account has any on-chain spends yet — generate one, re-run
//   UNSUPPORTED      spends exist but carry neither known shape — isSelfSend would be a
//                    silent no-op; STOP and adapt before landing Phase 1
import { PrismaClient } from '@prisma/client'
import { lwsClient } from '../api/monero/lwsClient.js'

const prisma = new PrismaClient()

function shapeOf (so) {
  if (so?.maj_i != null && so?.min_i != null) return 'flat{maj_i,min_i}'
  if (so?.recipient?.maj_i != null && so?.recipient?.min_i != null) return 'nested{recipient.maj_i,min_i}'
  if (so?.sender?.maj_i != null && so?.sender?.min_i != null) return 'nested{sender.maj_i,min_i}'
  return `UNSUPPORTED keys=[${Object.keys(so || {}).sort().join(',')}]`
}

async function main () {
  try {
    const accounts = await prisma.moneroAccount.findMany({
      where: { status: 'ACTIVE' },
      include: { viewKey: true }
    })
    const shapes = new Map()
    let spentTxCount = 0
    for (const account of accounts) {
      // Mirror reconcilePendingTips: skip unscannable accounts rather than abort.
      if (!account.viewKey) continue
      const resp = await lwsClient.getAddressTxs(account, 0, null)
      for (const tx of resp.transactions || []) {
        if (!tx.spent_outputs || tx.spent_outputs.length === 0) continue
        spentTxCount += 1
        for (const so of tx.spent_outputs) {
          const shape = shapeOf(so)
          shapes.set(shape, (shapes.get(shape) || 0) + 1)
        }
      }
    }
    console.log(`scanned ${accounts.length} ACTIVE account(s); ${spentTxCount} tx(s) carry spent_outputs`)
    for (const [shape, count] of [...shapes].sort()) console.log(`  ${shape}: ${count} output(s)`)

    if (shapes.size === 0) {
      console.log('NO-SPENT-OUTPUTS: no account history contains spends yet.')
      console.log('  cheapest generator on dev: send any tx OUT of a scanned wallet (e.g. a')
      console.log('  rewards-wallet distribution via ./sndev monero, or a wallet sending to')
      console.log('  its own integrated address — a literal self-send), then re-run.')
      return
    }
    const supported = [...shapes.keys()].some(s => s.startsWith('flat') || s.startsWith('nested'))
    if (!supported) {
      console.error('UNSUPPORTED: spent_outputs carry subaddress indices in NEITHER known shape —')
      console.error('isSelfSend would silently never match. Do not land Phase 1 until the parser')
      console.error('is adapted to the dumped key set above (or lws is upgraded). Part C caps')
      console.error('remain the only bound on undetected self-sends in the meantime.')
      process.exitCode = 1
      return
    }
    console.log('SUPPORTED: isSelfSend has real subaddress indices to match')
  } finally {
    await prisma.$disconnect()
  }
}

main()
