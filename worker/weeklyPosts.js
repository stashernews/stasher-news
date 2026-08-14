import pay from '@/api/payIn'
import { BOSS_RETRY, USER_ID } from '@/lib/constants'
import { datePivot } from '@/lib/time'
import gql from 'graphql-tag'

export async function autoPost ({ data: item, models, apollo, boss }) {
  return await pay('ITEM_CREATE',
    { subNames: ['meta'], ...item, userId: USER_ID.sn, apiKey: true },
    {
      me: { id: USER_ID.sn },
      custodialOnly: true
    })
}

export async function weeklyPost (args) {
  const { result: { id, bounty } } = await autoPost(args)

  if (bounty) {
    args.boss.send('payWeeklyPostBounty', { id }, { ...BOSS_RETRY, startAfter: datePivot(new Date(), { hours: 24 }) })
  }
}

export async function payWeeklyPostBounty ({ data: { id }, models, apollo, pay: payFn = pay }) {
  const itemQ = await apollo.query({
    query: gql`
      query item($id: ID!) {
        item(id: $id) {
          userId
          bounty
          bountyWinnerCommentId
          comments(sort: "top") {
            comments {
              id
            }
          }
        }
      }`,
    variables: { id }
  })

  const item = itemQ.data.item
  if (item.bountyWinnerCommentId != null) {
    throw new Error('Bounty already paid')
  }

  const winner = item.comments.comments[0]
  if (!winner) {
    throw new Error('No winner')
  }

  // CAS claim BEFORE paying: a retried/duplicate job loses the race and
  // no-ops instead of double-paying. This repo has no Item.bountyPaidTo
  // column — A-13 replaced it with bountyWinnerCommentId (schema.prisma) —
  // so the claim conditionally sets bountyWinnerCommentId, mirroring the
  // payBounty claim transaction in api/resolvers/bounty.js (single-writer
  // domain: any concurrent award already set the column and this claim
  // loses). The api/ TIP payIn flow never writes it (verified by grep).
  // bountyStatus: { not: 'FUNDED' } mirrors payBounty's FUNDED-gated claim
  // (api/resolvers/bounty.js:191-194) so the two claim predicates can never
  // both fire on the same row: an escrow-FUNDED bounty belongs to the
  // payBounty award path, not this custodial TIP.
  const claimed = await models.item.updateMany({
    where: { id: Number(id), bountyWinnerCommentId: null, bountyStatus: { not: 'FUNDED' } },
    data: { bountyWinnerCommentId: Number(winner.id) }
  })
  if (claimed.count === 0) {
    throw new Error('Bounty claim lost — payout may be stranded and needs manual reconciliation')
  }

  await payFn('TIP',
    { id: winner.id, sats: item.bounty },
    {
      me: { id: USER_ID.sn },
      custodialOnly: true
    })
}
