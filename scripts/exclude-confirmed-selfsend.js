// One-off remediation: exclude + reverse a CONFIRMED self-send (wash) tip that
// slipped past the 0-conf exclusion check before the confirm-time re-check
// existed (the detection-time lws scan cannot see spent_outputs for a mempool
// tx, so a wash tip paid from the author's own wallet via a different tipper
// account failed open and was fully detected, ranked, and credited).
//
// Re-verifies the self-send via a live lws scan (isSelfSend) before touching
// anything — the script refuses to exclude a tip it cannot prove. Reverses:
//   - the detection-applied ranking delta (reverseTip: upvotes, weightedVotes,
//     tip totals, capped rank terms, ItemUserAgg / anon bucket, ancestors)
//   - the confirmation-time author credit (stackedPiconeros decrement)
//   - the tip row: CONFIRMED -> EXCLUDED with exclusionReason SELF_SEND
// and writes the AbuseSignal row the missed exclusion should have written.
// Streaks granted at DETECTED are an accepted residual (same posture as the
// REORGED reversal — constants.js note).
//
// Dry-run by default; pass --apply to execute.
//
//   docker exec -w /app -u apprunner app npx tsx --tsconfig jsconfig.json \
//     scripts/exclude-confirmed-selfsend.js <tipId> [--apply]
import { Prisma, PrismaClient } from '@prisma/client'
import { lwsClient } from '../api/monero/lwsClient.js'
import { isSelfSend, resolveItemSubName } from '../api/monero/selfTip.js'
import { reverseTip } from '../api/monero/ranking.js'

const prisma = new PrismaClient()

async function main () {
  const [, , tipIdArg, ...rest] = process.argv
  const apply = rest.includes('--apply')
  const tipId = tipIdArg ? BigInt(tipIdArg) : null
  if (tipId == null) {
    console.error('usage: exclude-confirmed-selfsend.js <tipId> [--apply]')
    process.exitCode = 1
    return
  }

  const tip = await prisma.observedTip.findUnique({
    where: { id: tipId },
    include: {
      post: { select: { userId: true } },
      recipientAccount: {
        select: { id: true, label: true, address: true, status: true, viewKey: true, lastTxId: true, subaddresses: { select: { majorIndex: true, minorIndex: true } } }
      }
    }
  })
  if (!tip) {
    console.error(`tip ${tipId}: not found`)
    process.exitCode = 1
    return
  }
  if (tip.state !== 'CONFIRMED') {
    console.error(`tip ${tipId}: state is ${tip.state}, expected CONFIRMED (the confirm-time re-check now handles DETECTED rows automatically)`)
    process.exitCode = 1
    return
  }
  const account = tip.recipientAccount
  if (!account?.viewKey || account.status !== 'ACTIVE') {
    console.error(`tip ${tipId}: recipient account ${account?.id} is unscannable (no view key / INACTIVE) — verify manually before remediating`)
    process.exitCode = 1
    return
  }

  // Full-history scan (no cursor games — this is a one-off): find the tip tx
  // by payment id and re-verify the self-send exactly as isSelfSend would.
  const resp = await lwsClient.getAddressTxs(account, 0, null)
  const tx = (resp.transactions || []).find(t =>
    String(t.payment_id || '').toLowerCase() === String(tip.paymentId).toLowerCase()) || null
  if (!isSelfSend(account, tx)) {
    console.error(`tip ${tipId}: lws scan does NOT prove a self-send (tx found: ${!!tx}) — refusing. Re-verify with scripts/probe-lws-spent-outputs.js shapes in mind.`)
    process.exitCode = 1
    return
  }
  const senders = (tx.spent_outputs || []).map(so => `(${so?.sender?.maj_i},${so?.sender?.min_i})`).join(' ')
  console.log(`tip ${tipId}: CONFIRMED self-send VERIFIED — piconeros=${tip.piconeros} rankPiconeros=${tip.rankPiconeros} spent_output senders=[${senders}]`)

  const authorId = tip.post?.userId
  const credited = account.label !== 'platform_rewards' && authorId != null
  if (!apply) {
    console.log('dry-run: would EXCLUDE the tip, reverse the ranking delta,' +
      `${credited ? ` decrement user ${authorId} stackedPiconeros by ${tip.piconeros},` : ''} and write the AbuseSignal`)
    console.log('re-run with --apply to execute')
    return
  }

  let claimed = 0
  await prisma.$transaction(async (txh) => {
    claimed = await txh.$executeRaw`
      UPDATE "ObservedTip"
      SET state = 'EXCLUDED', "exclusionReason" = 'SELF_SEND'::"TipExclusionReason"
      WHERE id = ${tip.id} AND state = 'CONFIRMED'`
    if (claimed > 0) {
      await reverseTip(tip.postId, tip.tipperId, tip.piconeros, tip.rankPiconeros, txh)
      if (credited) {
        await txh.user.update({
          where: { id: authorId },
          data: { stackedPiconeros: { decrement: tip.piconeros } }
        })
      }
      const subName = await resolveItemSubName(tip.postId, txh)
      await txh.abuseSignal.create({
        data: {
          kind: 'SELF_SEND_EXCLUDED',
          subjectUserId: authorId,
          actorUserId: tip.tipperId ?? null,
          tipId: tip.id,
          postId: tip.postId,
          subName,
          piconeros: tip.piconeros,
          txHash: tip.txHash || 'unknown',
          paymentId: tip.paymentId,
          details: {
            note: 'amount recorded as lws reported it (change-output inflation possible)',
            remediation: 'CONFIRMED wash tip excluded retroactively (predate of the confirm-time self-send re-check); ranking delta and author credit reversed'
          }
        }
      })
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

  if (claimed === 0) {
    console.warn(`tip ${tipId}: claim lost (state changed concurrently) — nothing written`)
    return
  }
  console.log(`tip ${tipId}: EXCLUDED, ranking delta reversed,${credited ? ` author ${authorId} credit reversed,` : ''} AbuseSignal written`)
}

main()
  .catch(err => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
