import { PAID_ACTION_PAYMENT_METHODS } from '@/lib/constants'
import { GqlInputError } from '@/lib/error'

export const anonable = false

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.FEE_CREDIT,
  PAID_ACTION_PAYMENT_METHODS.REWARD_SATS,
  PAID_ACTION_PAYMENT_METHODS.PESSIMISTIC
]

export async function getInitial (models, { id }, { me }) {
  const pollOption = await models.pollOption.findUnique({
    where: { id: parseInt(id) },
    include: { item: true }
  })
  if (!pollOption) throw new GqlInputError('poll option not found')

  // StasherNews: poll votes are free (the fork removed poll-vote founder
  // revenue), so the payIn carries piconeros 0n and is PAID at creation.
  return {
    payInType: 'POLL_VOTE',
    userId: me?.id,
    piconeros: 0n,
    pollVote: {
      pollOptionId: pollOption.id,
      itemId: pollOption.itemId
    },
    itemPayIn: {
      itemId: pollOption.itemId
    }
  }
}

export async function onBegin (tx, payInId, { id }) {
  const { userId } = await tx.payIn.findUnique({ where: { id: payInId } })
  // XXX this is only a sufficient check because of the row locks we
  // take for payIns that might race with this one
  const meVoted = await tx.payIn.findFirst({
    where: {
      userId,
      id: { not: payInId },
      payInType: 'POLL_VOTE',
      // post-free-vote every POLL_VOTE is PAID at creation (piconeros 0n), so a
      // prior conflicting vote can only be in 'PAID'; 'PENDING'/'PENDING_HELD'
      // were Lightning states removed from the PayInState enum in this fork.
      payInState: { in: ['PAID'] },
      itemPayIn: {
        item: {
          pollOptions: {
            some: {
              id: Number(id)
            }
          }
        }
      }
    }
  })
  if (meVoted) {
    throw new GqlInputError('already voted')
  }
  // anonymize the vote
  await tx.pollVote.updateMany({ where: { payInId }, data: { payInId: null } })
  return { id }
}

export async function describe (models, payInId) {
  const pollVote = await models.pollVote.findUnique({ where: { payInId } })
  return `SN: vote on poll #${pollVote.itemId}`
}
