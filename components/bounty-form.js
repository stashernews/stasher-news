import { Form, Input, SNInput } from '@/components/form'
import InputGroup from 'react-bootstrap/InputGroup'
import { bountySchema } from '@/lib/validate'
import { number } from 'yup'
import { MAX_TITLE_LENGTH } from '@/lib/constants'
import { ItemButtonBar } from './post'
import { UPSERT_BOUNTY } from '@/fragments/payIn'
import { usePostFormShared } from './use-post-form-shared'
import BountyFundingView from './bounty-funding-view'
import { useShowModal } from './modal'
import { useToast } from './toast'
import { getPayIn, isPostingFeeSubmit } from '@/lib/pay-in'
import { piconerosToXmrDecimal, xmrToPiconeros } from '@/lib/format'
import { BOUNTY_MIN_XMR, bountyPiconerosOf } from '@/lib/bounty'
import { useRef } from 'react'

// Decimal XMR entry (mirrors the tip modal's amount field + xmrAmountSchema);
// the submit path converts to piconeros for the bountyPiconeros upsert arg.
// The min message derives from BOUNTY_MIN_PICONEROS so it can never drift from
// the server's floor.
const amountValidator = number().typeError('must be a number').required('required')
  .positive('must be positive')
  .min(BOUNTY_MIN_XMR, `must be at least ${BOUNTY_MIN_XMR} XMR`)

export function BountyForm ({
  item,
  subs,
  EditInfo,
  titleLabel = 'title',
  bountyLabel = 'bounty amount (XMR)',
  textLabel = 'text',
  handleSubmit,
  children
}) {
  const showModal = useShowModal()
  const toaster = useToast()
  // the converted piconeros from the last submit, handed to the funding view
  // once the upsert completes
  const amountPiconerosRef = useRef(null)

  const { initial, onSubmit, storageKeyPrefix, schema } = usePostFormShared({
    item,
    subs,
    mutation: UPSERT_BOUNTY,
    storageKeyPrefix: 'bounty',
    schemaFn: bountySchema,
    extraInitialValues: {
      // the server's bountySchema requires bountyPiconeros, so an edit sends
      // the item's current amount as the initial value (unchanged unless the
      // author edits it)
      amount: item?.bountyPiconeros != null
        ? piconerosToXmrDecimal(bountyPiconerosOf(item.bountyPiconeros))
        : '0.001'
    },
    // on create, route to the funding view instead of the feed redirect; on
    // edit, keep the normal redirect back to the item
    navigateOnSubmit: !!item,
    onSuccessfulSubmit: item
      ? undefined
      : (data) => {
          const response = getPayIn(data)
          const postId = response?.payerPrivates?.result?.id
          // a fee-gated bounty shows the posting-fee modal instead; the funding
          // view is reachable from the post page once the fee lands
          if (!postId || isPostingFeeSubmit(response)) return
          showModal(onClose => <BountyFundingView postId={postId} amountPiconeros={amountPiconerosRef.current} onClose={onClose} />)
        }
  })

  // the client schema validates the decimal XMR amount field; the server
  // schema's bountyPiconeros member is validated server-side after conversion
  const formSchema = schema?.omit(['bountyPiconeros']).shape({ amount: amountValidator })

  const submit = handleSubmit || (async (values, args) => {
    const { amount, ...rest } = values
    let piconeros
    try {
      piconeros = Number(xmrToPiconeros(String(amount)))
    } catch {
      toaster.danger(`enter a valid XMR amount (min ${BOUNTY_MIN_XMR})`)
      return
    }
    amountPiconerosRef.current = piconeros
    await onSubmit({ ...rest, bountyPiconeros: piconeros }, args)
  })

  return (
    <Form
      initial={initial}
      schema={formSchema}
      requireSession
      onSubmit={submit}
      storageKeyPrefix={storageKeyPrefix}
    >
      {children}
      <Input
        label={titleLabel}
        name='title'
        required
        autoFocus
        clear
        maxLength={MAX_TITLE_LENGTH}
      />
      <Input
        label={bountyLabel} name='amount' required
        append={<InputGroup.Text className='text-monospace'>XMR</InputGroup.Text>}
      />
      <SNInput
        topLevel
        label={
          <>
            {textLabel} <small className='text-muted ms-2'>optional</small>
          </>
        }
        name='text'
        minRows={6}
        hint={EditInfo}
      />
      <ItemButtonBar itemId={item?.id} canDelete={false} />
    </Form>
  )
}
