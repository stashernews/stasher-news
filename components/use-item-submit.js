import { useRouter } from 'next/router'
import { useToast } from './toast'
import usePayInMutation from '@/components/payIn/hooks/use-pay-in-mutation'
import useCrossposter from './use-crossposter'
import { useCallback } from 'react'
import { toastUpsertSuccessMessages } from '@/lib/form'
import { composeCallbacks } from '@/lib/compose-callbacks'
import { getPayIn, isPostingFeeSubmit } from '@/lib/pay-in'
import { useMe } from './me'
import { useBranding } from './territory-branding'
import PostingFeeModal from './posting-fee-modal'
import UploadFeeModal from './upload-fee-modal'
import { useShowModal } from './modal'

// this is intented to be compatible with upsert item mutations
// so that it can be reused for all post types and comments and we don't have
// to maintain several copies of the same code
// it's a bit much for an abstraction ... but it makes it easy to modify item-payment UX
// and other side effects like crossposting and redirection
// ... or I just spent too much time in this code and this is overcooked
// NOTE: sub is only used for the job form currently since it's the only form that can exist in a single territory
export default function useItemSubmit (mutation,
  { item, sub, onSuccessfulSubmit, navigateOnSubmit = true, extraValues = {}, payInMutationOptions = { } } = {}) {
  const router = useRouter()
  const toaster = useToast()
  const crossposter = useCrossposter()
  const [upsertItem] = usePayInMutation(mutation)
  const { me } = useMe()
  const branding = useBranding()
  const showModal = useShowModal()

  return useCallback(
    async ({ subNames: submittedSubNames, crosspost, title, options, bounty, status, ...values }, { resetForm }) => {
      if (options) {
        // remove existing poll options since else they will be appended as duplicates
        options = options.slice(item?.poll?.options?.length || 0).filter(o => o.trim().length > 0)
      }

      const subNames = submittedSubNames || item?.subNames || (sub?.name ? [sub.name] : [])
      const {
        cachePhases: payInCachePhases = {},
        onCompleted: payInOnCompleted,
        ...restPayInMutationOptions
      } = payInMutationOptions
      const mergedCachePhases = {
        ...payInCachePhases,
        // a pessimistic item create/update has no genesis result, so the mutation-phase cache work
        // (comment injection, ncomments...) must be deferred to the paid phase. re-run it then, but
        // against the root cache — onPaidMissingResult runs outside Apollo's update() context.
        onPaidMissingResult: composeCallbacks(
          payInCachePhases.onPaidMissingResult,
          payInCachePhases.onMutationResult
            ? (cache, ...args) => payInCachePhases.onMutationResult(nonOptimisticCache(cache), ...args)
            : undefined
        )
      }

      const { data, error, payError } = await upsertItem({
        variables: {
          id: item?.id,
          subNames,
          bounty: bounty ? Number(bounty) : undefined,
          status: status === 'STOPPED' ? 'STOPPED' : 'ACTIVE',
          title: title?.trim(),
          options,
          ...values,
          ...extraValues
        },
        // if not a comment, we want the qr to persist on navigation
        persistOnNavigate: navigateOnSubmit,
        ...restPayInMutationOptions,
        cachePhases: mergedCachePhases,
        onCompleted: (data) => {
          onSuccessfulSubmit?.(data, { resetForm })
          payInOnCompleted?.(data)
        }
      })

      if (error) throw error
      if (payError) return

      // we don't know the mutation name, so we have to extract the result
      const response = getPayIn(data)
      const postId = response?.payerPrivates.result?.id

      if (crosspost && postId) {
        await crossposter(postId)
      }

      toastUpsertSuccessMessages(toaster, data, Object.keys(data)[0], values.text)

      // StasherNews: an ITEM_CREATE beyond the free quota (posts AND replies)
      // returns a monero: URI for the fee and is PENDING_FEE until the
      // rewardsWalletObserver observes it on-chain — surface the payment instead
      // of redirecting to the feed.
      //
      // The submit succeeded (the item exists, PENDING_FEE), so reset the form —
      // otherwise a dismissed modal leaves the post page with the same content,
      // and clicking post again mints a duplicate item with a second posting fee.
      //
      // Show the modal regardless of navigateOnSubmit (in-place submits must
      // still surface the fee); only the redirect is gated on it. persistOnNavigate
      // was set up for route-based QR persistence; the modal now owns the QR
      // display, so the early return makes that option inert for fee posts.
      //
      // Which modal: a create is gated by Item.feeStatus (flips to FEE_PAID when
      // the posting fee is observed), so PostingFeeModal tracks it. An EDIT's
      // upload fee has no state that flips — the item's feeStatus still reads
      // FEE_PAID from the creation fee — so it tracks the fee PayIn directly via
      // UploadFeeModal (PayIn.feeCovered), otherwise the fee would be silently
      // waived.
      if (isPostingFeeSubmit(response)) {
        resetForm?.()
        showModal(onClose => item
          ? <UploadFeeModal moneroUri={response.moneroUri} payInId={response.id} onClose={onClose} />
          : <PostingFeeModal moneroUri={response.moneroUri} itemId={postId} />)
        if (navigateOnSubmit) {
          return
        }
      }

      // if we're not a comment, we want to redirect after the mutation
      if (navigateOnSubmit) {
        if (item) {
          await router.push(`/items/${item.id}`)
        } else {
          const prefix = branding ? '' : (subNames.length === 1 ? `/~${subNames[0]}` : '')
          await router.push(prefix + '/new')
        }
      }
    }, [me, showModal, upsertItem, router, crossposter, item, onSuccessfulSubmit,
      navigateOnSubmit, extraValues, payInMutationOptions, branding]
  )
}

// a cache whose .modify forces optimistic:false, so a mutation-phase cache write can be re-run in
// a paid phase (outside Apollo's update() context) without leaking into an optimistic layer
function nonOptimisticCache (cache) {
  return Object.create(cache, {
    modify: { value: (options) => cache.modify({ ...options, optimistic: false }) }
  })
}
