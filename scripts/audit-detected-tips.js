// Pre-deploy audit (2026-09-11 review, finding 2): scan every DETECTED
// ObservedTip and bind its stored piconeros/txHash to the chain tx found for
// its payment id. Rows created through the pre-verification webhook may carry
// forged amounts; once the confirm-time CHAIN_MISMATCH exclusion is deployed
// they are excluded automatically — but the DETECTED-time ranking deltas they
// already applied need visibility before that deploy, and the operator may
// want to reconcile them manually (see scripts/exclude-confirmed-selfsend.js
// for the reversal pattern).
//
// Read-only: no state changes, and lookupTipTx never advances the rewards
// account's observer cursor (its guard). Unscannable accounts (no view key /
// INACTIVE) are listed as SKIPPED — the same documented fail-open posture the
// runtime checks keep.
//
//   docker exec -w /app -u apprunner app npx tsx --tsconfig jsconfig.json \
//     scripts/audit-detected-tips.js
//
// Exit codes: 0 = clean (or only SKIPPED rows), 1 = at least one mismatch /
// tx-not-found row, 2 = lws error.
import { PrismaClient } from '@prisma/client'
import { lwsClient } from '../api/monero/lwsClient.js'
import { lookupTipTx, chainMismatch } from '../api/monero/selfTip.js'

const prisma = new PrismaClient()

async function main () {
  const tips = await prisma.observedTip.findMany({
    where: { state: 'DETECTED' },
    include: {
      post: { select: { userId: true } },
      recipientAccount: {
        select: { id: true, label: true, address: true, status: true, viewKey: true, lastTxId: true, subaddresses: { select: { majorIndex: true, minorIndex: true } } }
      }
    },
    orderBy: { id: 'asc' }
  })
  let bad = 0
  let ok = 0
  let skipped = 0
  console.log(`auditing ${tips.length} DETECTED tip(s)`)
  for (const tip of tips) {
    const account = tip.recipientAccount
    if (!account?.viewKey || account.status !== 'ACTIVE') {
      console.log(`tip ${tip.id}: SKIPPED (unscannable account ${account?.id ?? 'none'}) stored=${tip.piconeros}`)
      skipped += 1
      continue
    }
    let tx
    try {
      tx = await lookupTipTx(prisma, lwsClient, account, tip.paymentId)
    } catch (err) {
      console.error(`tip ${tip.id}: LWS ERROR ${err?.message || err}`)
      process.exitCode = 2
      continue
    }
    if (!tx) {
      console.log(`tip ${tip.id}: TX_NOT_FOUND pid=${tip.paymentId} stored=${tip.piconeros} txHash=${tip.txHash} — no chain evidence (fully forged or pid typo)`)
      bad += 1
      continue
    }
    if (chainMismatch(tip, tx)) {
      console.log(`tip ${tip.id}: MISMATCH pid=${tip.paymentId} stored=${tip.piconeros} onChain=${tx.piconeros} storedTxHash=${tip.txHash} onChainTxHash=${tx.hash}`)
      bad += 1
    } else {
      console.log(`tip ${tip.id}: ok stored=${tip.piconeros} txHash=${tx.hash}`)
      ok += 1
    }
  }
  console.log(`\n${ok} ok, ${bad} needing remediation, ${skipped} skipped`)
  if (bad > 0) process.exitCode = 1
}

main().catch((err) => { console.error(err); process.exitCode = 2 }).finally(() => prisma.$disconnect())
