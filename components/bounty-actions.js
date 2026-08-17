import { useCallback } from 'react'
import { useApolloClient, useMutation } from '@apollo/client/react'
import Button from 'react-bootstrap/Button'
import Dropdown from 'react-bootstrap/Dropdown'
import { useShowModal } from './modal'
import { useToast } from './toast'
import { useAnimation } from './animation'
import { piconerosToXmr } from '@/lib/format'
import { bountyPiconerosOf } from '@/lib/bounty'
import { AWARD_BOUNTY_MUTATION, RECLAIM_BOUNTY_MUTATION, ROLLOVER_BOUNTY_MUTATION } from '@/fragments/payIn'

// Bounty author controls (A-13 Task 7 Step 3): award on descendant comments,
// reclaim + roll over on an expired bounty post. All three queue an escrow
// payout (BountyPayment QUEUED) that the worker's signer dispatches; the
// on-chain payout is async, so the UI confirms the queueing and updates the
// item's bountyStatus in the Apollo cache.

function useBountyAction ({ mutation, variables, cacheStatus, successCopy, onClose }) {
  const { cache } = useApolloClient()
  const toaster = useToast()
  const animate = useAnimation()
  const [submit, { loading }] = useMutation(mutation)

  const run = useCallback(async () => {
    try {
      await submit({ variables })
      cache.modify({
        id: `Item:${variables.id}`,
        fields: { bountyStatus: () => cacheStatus }
      })
      animate()
      toaster.success(successCopy)
      onClose?.()
    } catch (error) {
      toaster.danger(error.message || 'bounty action failed')
    }
  }, [submit, variables, cacheStatus, successCopy, onClose, cache, toaster, animate])

  return { run, loading }
}

function BountyConfirmBody ({ title, description, amountPiconeros, confirmText, loading, onConfirm, onClose }) {
  const piconeros = bountyPiconerosOf(amountPiconeros)

  return (
    <div className='d-flex flex-column'>
      <h6 className='text-start'>{title}</h6>
      <p className='text-muted'>{description}</p>
      {amountPiconeros != null && piconeros > 0n &&
        <div className='text-monospace text-center mb-2'>
          {piconerosToXmr(piconeros)}
        </div>}
      <div className='d-flex justify-content-end gap-2'>
        <Button variant='secondary' onClick={onClose}>cancel</Button>
        <Button variant='primary' disabled={loading} onClick={onConfirm}>
          {loading ? 'submitting…' : confirmText}
        </Button>
      </div>
    </div>
  )
}

// "award bounty" action in the ... menu on a descendant comment of a FUNDED
// bounty, visible to the bounty author. Enabled when the comment author has an
// attached wallet (UserOptional.hasAttachedWallet — a plain wallet-exists
// check). Deliberately NOT gated on UserOptional.hasWallet (which also requires
// the canPostFree reputation bar), so a winner who is simply young or
// low-stacked is still awardable. The server re-checks the wallet and errors
// if it changed between render and submit.
export function AwardBountyDropdownItem ({ item, root }) {
  const showModal = useShowModal()
  const hasAttachedWallet = item.user?.optional?.hasAttachedWallet

  return (
    <Dropdown.Item
      disabled={!hasAttachedWallet}
      title={!hasAttachedWallet ? `${item.user?.name ?? 'this user'} has no wallet attached` : undefined}
      onClick={() => showModal(onClose => <AwardBountyModal item={item} root={root} onClose={onClose} />)}
    >
      award bounty
    </Dropdown.Item>
  )
}

function AwardBountyModal ({ item, root, onClose }) {
  const { run, loading } = useBountyAction({
    mutation: AWARD_BOUNTY_MUTATION,
    variables: { id: String(root.id), winnerCommentId: String(item.id) },
    cacheStatus: 'AWARDED',
    successCopy: 'bounty awarded — the payout is on its way',
    onClose
  })

  return (
    <BountyConfirmBody
      title='Award this bounty'
      description={<>Award the bounty to <strong>@{item.user?.name}</strong>? The payout goes to their attached wallet.</>}
      amountPiconeros={root.bountyPiconeros}
      confirmText='award'
      loading={loading}
      onConfirm={run}
      onClose={onClose}
    />
  )
}

// "reclaim bounty" + "roll over bounty" buttons on an EXPIRED bounty post,
// visible to the bounty author (item-full.js renders <BountyActions> only for
// item.mine && bountyStatus === 'EXPIRED').
export default function BountyActions ({ item }) {
  const showModal = useShowModal()

  return (
    <div className='d-flex flex-wrap gap-2 mt-3'>
      <Button
        size='sm' variant='outline-secondary'
        onClick={() => showModal(onClose => <ReclaimBountyModal item={item} onClose={onClose} />)}
      >
        reclaim bounty
      </Button>
      <Button
        size='sm' variant='outline-info'
        onClick={() => showModal(onClose => <RolloverBountyModal item={item} onClose={onClose} />)}
      >
        roll over bounty
      </Button>
    </div>
  )
}

function ReclaimBountyModal ({ item, onClose }) {
  const { run, loading } = useBountyAction({
    mutation: RECLAIM_BOUNTY_MUTATION,
    variables: { id: String(item.id) },
    cacheStatus: 'REFUNDED',
    successCopy: 'bounty reclaimed — the refund is on its way to your wallet',
    onClose
  })

  return (
    <BountyConfirmBody
      title='Reclaim this bounty'
      description='The bounty expired without being awarded. Reclaiming refunds the escrow balance to your attached wallet.'
      amountPiconeros={item.bountyPiconeros}
      confirmText='reclaim'
      loading={loading}
      onConfirm={run}
      onClose={onClose}
    />
  )
}

function RolloverBountyModal ({ item, onClose }) {
  const { run, loading } = useBountyAction({
    mutation: ROLLOVER_BOUNTY_MUTATION,
    variables: { id: String(item.id) },
    cacheStatus: 'ROLLED_OVER',
    successCopy: 'bounty rolled over — the escrow funds the curator rewards pool',
    onClose
  })

  return (
    <BountyConfirmBody
      title='Roll over this bounty'
      description='The bounty expired without being awarded. Rolling it over sends the full escrow balance (bounty + fee) to the weekly curator rewards pool.'
      amountPiconeros={item.bountyPiconeros}
      confirmText='roll over'
      loading={loading}
      onConfirm={run}
      onClose={onClose}
    />
  )
}
