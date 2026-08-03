import Button from 'react-bootstrap/Button'
import InputGroup from 'react-bootstrap/InputGroup'
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useApolloClient } from '@apollo/client/react'
import { Form, Input, SubmitButton } from './form'
import { useMe } from './me'
import UpBolt from '@/svgs/bolt.svg'
import { amountSchema } from '@/lib/validate'
import { defaultTipIncludingRandom } from './upvote'
import { ACT_MUTATION } from '@/fragments/payIn'
import { actWaitFor, getPayIn } from '@/lib/pay-in'
import { meAnonSats } from '@/lib/apollo'
import { toastPayError, isTransientNetworkError } from '@/wallets/client/errors'
import { useAnimation } from '@/components/animation'
import { useToast } from '@/components/toast'
import usePayInMutation from '@/components/payIn/hooks/use-pay-in-mutation'
import { composeCallbacks } from '@/lib/compose-callbacks'

const defaultTips = [100, 1000, 10_000, 100_000]

const Tips = ({ setOValue }) => {
  const customTips = getCustomTips()
  const defaultNoCustom = defaultTips.filter(d => !customTips.includes(d))
  const tips = [...customTips, ...defaultNoCustom].slice(0, 7).sort((a, b) => a - b)

  return tips.map((num, i) =>
    <Button
      size='sm'
      key={num}
      onClick={() => { setOValue(num) }}
    >
      <UpBolt
        className='me-1'
        width={14}
        height={14}
      />{num}
    </Button>)
}

const getCustomTips = () => JSON.parse(window.localStorage.getItem('custom-tips')) || []

const addCustomTip = (amount) => {
  const customTips = Array.from(new Set([amount, ...getCustomTips()])).slice(0, 7)
  window.localStorage.setItem('custom-tips', JSON.stringify(customTips))
}

const setItemMeAnonSats = ({ id, amount }) => {
  const reactiveVar = meAnonSats[id]
  const existingAmount = reactiveVar()
  reactiveVar(existingAmount + amount)

  // save for next page load
  const storageKey = `TIP-item:${id}`
  window.localStorage.setItem(storageKey, existingAmount + amount)
}

export default function ItemAct ({ onClose, item, act = 'TIP', step, children }) {
  const inputRef = useRef(null)
  const { me } = useMe()
  const toaster = useToast()
  const client = useApolloClient()
  const [oValue, setOValue] = useState()

  useEffect(() => {
    inputRef.current?.focus()
  }, [onClose, item.id])

  const actor = useAct()
  const animate = useAnimation()

  const onSubmit = useCallback(async ({ amount }) => {
    const onPaid = (cache, { data } = {}) => {
      animate()
      onClose?.()
      if (!me) setItemMeAnonSats({ id: item.id, amount })
    }

    // onPayError only fires for failures that won't be auto-retried; e is undefined when it's
    // invoked purely to revert a retry successor's cache, and a user-canceled QR isn't news
    const onPayError = (e) => toastPayError(toaster, e)

    const options = { cachePhases: { onPayError } }
    if (me?.privates?.sats > Number(amount)) {
      onPaid()
    } else {
      // we want to close the modal only after paid so the modal can stack
      options.cachePhases.onPaid = onPaid
    }

    // instant feedback: bump the item's counters directly in the root cache (monero tips are 100%
    // P2P, so TIP adds credits here; the act cache phases only reconcile ancestors on payment)
    const result = { id: item.id, sats: Number(amount), act, path: item.path }
    try {
      const { error } = await withActBump(client.cache, result, me, () =>
        // don't close modal immediately because we want the QR modal to stack
        actor({ variables: { id: item.id, sats: Number(amount), act }, ...options }))
      if (error) throw error
      addCustomTip(Number(amount))
    } catch (e) {
      // a gateway timeout (e.g. the recipient's wallet was slow to invoice) doesn't mean the zap
      // failed — it's processed server-side and the bump (kept by withActBump) reconciles. don't toast.
      if (!isTransientNetworkError(e)) throw e
    }
  }, [me, actor, client, act, item.id, item.path, onClose, animate, toaster])

  return (
    <Form
      initial={{
        amount: defaultTipIncludingRandom(me?.privates) || defaultTips[0]
      }}
      schema={amountSchema}
      onSubmit={onSubmit}
    >
      <Input
        label='amount'
        name='amount'
        type='number'
        innerRef={inputRef}
        overrideValue={oValue}
        step={step}
        required
        autoFocus
        append={<InputGroup.Text className='text-monospace'>sats</InputGroup.Text>}
      />

      <div className='d-flex flex-wrap gap-2'>
        <Tips setOValue={setOValue} />
      </div>
      <div className='d-flex mt-3'>
        <SubmitButton variant={act === 'DONT_LIKE_THIS' ? 'danger' : 'success'} className='ms-auto mt-1 px-4' value={act}>
          {act === 'DONT_LIKE_THIS' ? 'downvote' : act === 'BOOST' ? 'boost' : 'tip'}
        </SubmitButton>
      </div>
      {children}
    </Form>
  )
}

function modifyActCache (cache, { payerPrivates }, me) {
  const result = payerPrivates?.result
  if (!result) return
  const { id, sats, act } = result

  cache.modify({
    id: `Item:${id}`,
    fields: {
      sats (existingSats = 0) {
        if (act === 'TIP') {
          return existingSats + sats
        }
        return existingSats
      },
      credits (existingCredits = 0) {
        if (act === 'TIP') {
          return existingCredits + sats
        }
        return existingCredits
      },
      meSats: (existingSats = 0) => {
        if (act === 'TIP' && me) {
          return existingSats + sats
        }
        return existingSats
      },
      meCredits: (existingCredits = 0) => {
        if (act === 'TIP' && me) {
          return existingCredits + sats
        }
        return existingCredits
      },
      meDontLikeSats: (existingSats = 0) => {
        if (act === 'DONT_LIKE_THIS') {
          return existingSats + sats
        }
        return existingSats
      },
      downSats: (existingSats = 0) => {
        if (act === 'DONT_LIKE_THIS') {
          return existingSats + sats
        }
        return existingSats
      },
      boost: (existingBoost = 0) => {
        if (act === 'BOOST') {
          return existingBoost + sats
        }
        return existingBoost
      }
    }
  })
}

// doing this onPaid fixes issue #1695 because optimistically updating all ancestors
// conflicts with the writeQuery on navigation from SSR
function updateAncestors (cache, { payerPrivates }) {
  const result = payerPrivates?.result
  if (!result) return
  const { id, sats, act, path } = result

  if (act === 'TIP') {
    // update all ancestors
    path.split('.').forEach(aId => {
      if (Number(aId) === Number(id)) return
      cache.modify({
        id: `Item:${aId}`,
        fields: {
          commentCredits (existingCommentCredits = 0) {
            return existingCommentCredits + sats
          },
          commentSats (existingCommentSats = 0) {
            return existingCommentSats + sats
          }
        }
      })
    })
  }
  if (act === 'DONT_LIKE_THIS') {
    // update all ancestors
    path.split('.').forEach(aId => {
      if (Number(aId) === Number(id)) return
      cache.modify({
        id: `Item:${aId}`,
        fields: {
          commentDownSats (existingCommentDownSats = 0) {
            return existingCommentDownSats + sats
          }
        }
      })
    })
  }
  if (act === 'BOOST') {
    // update all ancestors
    path.split('.').forEach(aId => {
      if (Number(aId) === Number(id)) return
      cache.modify({
        id: `Item:${aId}`,
        fields: {
          commentBoost (existingCommentBoost = 0) {
            return existingCommentBoost + sats
          }
        }
      })
    })
  }
}

// act bump: write an item's counters to the ROOT cache (survives navigation under maxMerge).
// tips settle 100% P2P in monero, so TIP adds credits outright (DONT_LIKE_THIS/BOOST never touch
// credits). used by this modal (via withActBump) and tip-modal (directly).
export function bumpActCache (cache, result, me) {
  modifyActCache(cache, { payerPrivates: { result } }, me)
}

// reverse a bump: TIP's credits are reversed alongside its sats.
export function revertActBump (cache, result, me) {
  modifyActCache(cache, { payerPrivates: { result: { ...result, sats: -result.sats } } }, me)
}

// bump an item's counters at click time, run the act attempt, and revert the bump if the attempt
// throws before a payIn exists (no cache phase reverts then). returns the attempt's result; a
// returned (non-thrown) error is left for getActCachePhases.onPayError. used by the modal and the
// notifications retry.
export async function withActBump (cache, result, me, attempt) {
  bumpActCache(cache, result, me)
  try {
    return await attempt()
  } catch (e) {
    // a gateway timeout means the act is likely still being processed server-side — keep the
    // optimistic bump
    if (!isTransientNetworkError(e)) revertActBump(cache, result, me)
    throw e
  }
}

// the bump already wrote the item's counters (including TIP credits) to the root cache; these
// phases only reconcile what the bump couldn't know up front: the reversal (on terminal failure)
// and the ancestors (on payment).
export function getActCachePhases (me) {
  return {
    onPayError: (e, cache, { data }) => {
      const response = getPayIn(data)
      const result = response?.payerPrivates?.result
      if (result) revertActBump(cache, result, me)
    },
    onPaid: (cache, { data }) => {
      const response = getPayIn(data)
      if (!response) return
      updateAncestors(cache, response)
    }
  }
}

export function useAct ({ query = ACT_MUTATION, ...options } = {}) {
  const { me } = useMe()
  const phases = getActCachePhases(me)
  const { cachePhases: callerCachePhases = {}, ...restOptions } = options

  const [act] = usePayInMutation(query, {
    waitFor: actWaitFor(),
    ...restOptions,
    cachePhases: {
      ...callerCachePhases,
      onPayError: composeCallbacks(phases.onPayError, callerCachePhases.onPayError),
      onPaid: composeCallbacks(phases.onPaid, callerCachePhases.onPaid)
    }
  })
  return act
}
