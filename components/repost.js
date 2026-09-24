import { useState } from 'react'
import Dropdown from 'react-bootstrap/Dropdown'
import ListGroup from 'react-bootstrap/ListGroup'
import Button from 'react-bootstrap/Button'
import { useQuery } from '@apollo/client/react'
import { useRouter } from 'next/router'
import { useMe } from './me'
import { useShowModal } from './modal'
import { useToast } from './toast'
import usePayInMutation from '@/components/payIn/hooks/use-pay-in-mutation'
import { REPOST_ITEM } from '@/fragments/payIn'
import { ACTIVE_SUBS } from '@/fragments/subs'
import { MAX_ITEM_TURFS, SSR } from '@/lib/constants'
import { itemPostType } from '@/lib/subs'
import { piconerosToMXmr } from '@/lib/format'
import { getPayIn, isPostingFeeSubmit } from '@/lib/pay-in'
import RepostFeeModal from './repost-fee-modal'

export function RepostDropdownItem ({ item }) {
  const showModal = useShowModal()
  return (
    <Dropdown.Item onClick={() => showModal(onClose => <RepostModal item={item} onClose={onClose} />)}>
      repost to another turf
    </Dropdown.Item>
  )
}

// Exported for the local component test: the linkedom harness can't drive
// text-input onChange (see territory-form-premiums.test.js:145), so the search
// semantics are pinned as a pure function. Trims and matches case-insensitively.
export function filterRepostCandidates (candidates, query) {
  const needle = query.trim().toLowerCase()
  return needle ? candidates.filter(sub => sub.name.toLowerCase().includes(needle)) : candidates
}

// RepostModal — the ⋯ menu picker for adding a live post to one more turf.
// SINGLE-select on purpose: one turf per repost keeps every fee a single clean
// leg to a single destination (the owner-direct route resolves only for exactly
// one non-owned turf). Owned turfs are free; other turfs quote the same
// floor + owner-premium math the server charges. The item's own turfs, muted
// turfs, and turfs that don't accept the item's post type are excluded.
export function RepostModal ({ item, onClose }) {
  const { me } = useMe()
  const showModal = useShowModal()
  const toaster = useToast()
  const router = useRouter()
  const [repost] = usePayInMutation(REPOST_ITEM)
  const [selected, setSelected] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [query, setQuery] = useState('')
  const { data } = useQuery(ACTIVE_SUBS, SSR ? {} : { nextFetchPolicy: 'cache-and-network' })

  const type = itemPostType(item)
  const candidates = (data?.activeSubs ?? []).filter(sub =>
    !item.subNames?.includes(sub.name) &&
    !sub.meMuteSub &&
    sub.postTypes?.includes(type)
  )
  const filtered = filterRepostCandidates(candidates, query)

  // Mirrors components/fee-button.js: the platform floor (always charged on a
  // turf addition — the free-post quota waives ITEM_CREATE only, never a repost)
  // plus the turf's post premium when owner fees are on. An owned turf is free.
  const quote = sub => {
    const owned = Number(sub.userId) === Number(me?.id)
    const floor = BigInt(me?.privates?.postingFeeFloorPiconeros || 0)
    const premium = me?.privates?.turfOwnerFees ? BigInt(sub.postPremiumPiconeros ?? 0) : 0n
    return { owned, amount: owned ? 0n : floor + premium }
  }

  const selectedQuote = selected ? quote(selected) : null

  const onSubmit = async () => {
    if (!selected || submitting) return
    setSubmitting(true)
    try {
      const { data: result, error, payError } = await repost({
        variables: { id: item.id, subName: selected.name },
        persistOnNavigate: true
      })
      if (error) throw error
      if (payError) return
      const response = getPayIn(result)
      onClose()
      if (isPostingFeeSubmit(response)) {
        showModal(onCloseFee => <RepostFeeModal moneroUri={response.moneroUri} payInId={response.id} itemId={item.id} onClose={onCloseFee} />)
      } else {
        toaster.success(`reposted to ~${selected.name}`)
        router.push(`/items/${item.id}`)
      }
    } catch (e) {
      toaster.danger('failed to repost')
      console.error('failed to repost item', e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className='d-flex flex-column'>
      <h6 className='text-center mb-1'>repost to another turf</h6>
      <p className='text-muted text-center'>
        <small>
          post #{item.id} · already in {item.subNames?.join(', ') || 'no turf'}
        </small>
      </p>
      {candidates.length === 0
        ? (
          <p className='text-muted text-center my-3'>
            no more turfs available ({MAX_ITEM_TURFS} max)
          </p>
          )
        : (
          <>
            <input
              type='text'
              className='form-control form-control-sm mb-2'
              placeholder='search turfs…'
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-label='search turfs'
            />
            {filtered.length === 0
              ? (
                <p className='text-muted text-center my-3'>
                  <small>no turfs match “{query}”</small>
                </p>
                )
              : (
                // Cap the list so a large turf count scrolls inside the modal
                // instead of growing it past the viewport.
                <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
                  <ListGroup variant='flush'>
                    {filtered.map(sub => {
                      const q = quote(sub)
                      const isSelected = selected?.name === sub.name
                      return (
                        <ListGroup.Item
                          key={sub.name}
                          action
                          active={isSelected}
                          onClick={() => setSelected(sub)}
                          className='d-flex justify-content-between align-items-center'
                        >
                          <span className='fw-bold'>~{sub.name}</span>
                          <span className='text-end'>
                            {q.owned
                              ? <span className={isSelected ? '' : 'text-success'}>free</span>
                              : <span className='fw-bold'>{piconerosToMXmr(q.amount)}</span>}
                          </span>
                        </ListGroup.Item>
                      )
                    })}
                  </ListGroup>
                </div>
                )}
          </>
          )}
      <div className='d-flex justify-content-between align-items-center mt-3'>
        <Button variant='link' className='text-muted text-decoration-none' onClick={onClose}>
          cancel
        </Button>
        <Button
          variant='success'
          disabled={!selected || submitting}
          onClick={onSubmit}
        >
          {submitting
            ? 'reposting…'
            : selectedQuote
              ? (selectedQuote.owned ? 'repost · free' : `repost · pay ${piconerosToMXmr(selectedQuote.amount)}`)
              : 'repost'}
        </Button>
      </div>
    </div>
  )
}
