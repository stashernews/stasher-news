import { useState } from 'react'
import { useFormikContext } from 'formik'
import { Form, SNInput } from '@/components/form'
import Button from 'react-bootstrap/Button'
import { useMutation } from '@apollo/client/react'
import { UPDATE_ITEM_ADDENDUM } from '@/fragments/item-addendum'
import { itemAddendumSchema } from '@/lib/validate'
import { submitItemAddendum, EXPIRED_FULL_EDIT_MESSAGE } from '@/lib/item-addendum'
import { MAX_ITEM_ADDENDUM_LENGTH } from '@/lib/constants'

// The free, post-window addendum editor (2026-10-04 spec). Deliberately not
// FeeButton/ItemButtonBar/useItemSubmit: this save never costs anything and
// never touches the original item. Empty text is an intentional clear; the
// Form clears the local draft after a successful submit.
export default function ItemAddendumForm ({ item, onSuccess, onCancel }) {
  const [updateItemAddendum] = useMutation(UPDATE_ITEM_ADDENDUM)
  // frozen at open: a save from another tab must conflict, not silently rebase
  const [expectedRevision] = useState(item.addendumRevision ?? 0)
  // local drafts are scoped per user AND per item, never the original edit/reply prefix
  const storageKeyPrefix = `item-addendum:${item.user?.id ?? item.userId}:${item.id}`

  return (
    <div className='mt-2'>
      <Form
        initial={{ text: item.addendumText ?? '' }}
        schema={itemAddendumSchema}
        storageKeyPrefix={storageKeyPrefix}
        onSubmit={async ({ text }) => {
          // on E_ADDENDUM_CONFLICT this throws (tagged) — the Form's catch
          // shows the message and skips its localStorage cleanup, so the
          // draft genuinely survives for the reload-and-retry flow
          await submitItemAddendum({ updateItemAddendum, id: item.id, text, expectedRevision })
          onSuccess?.()
        }}
      >
        <SNInput
          name='text'
          minRows={3}
          autoFocus
          allowUploads={false}
          allowMoneroWall={false}
          lengthOptions={{ maxLength: MAX_ITEM_ADDENDUM_LENGTH, show: true }}
          hint='Original text is locked. Add up to 200 characters; links and existing media are allowed.'
        />
        <AddendumSubmitRow
          onCancel={() => {
            // drop the local draft along with the editor
            window.localStorage.removeItem(storageKeyPrefix + '-text')
            onCancel?.()
          }}
        />
      </Form>
    </div>
  )
}

// Save is disabled while the mutation is in flight: Formik's handleSubmit does
// not guard on isSubmitting, so a double-click would fire two saves and the
// second would surface a FALSE "changed in another session" conflict.
function AddendumSubmitRow ({ onCancel }) {
  const { isSubmitting } = useFormikContext()
  return (
    <div className='d-flex justify-content-end gap-2 mt-1'>
      <Button variant='grey-medium' onClick={onCancel} disabled={isSubmitting}>cancel</Button>
      <Button type='submit' variant='main' disabled={isSubmitting}>save addendum</Button>
    </div>
  )
}

// Shown when the original 10-minute window ends while the full editor is open
// (inline comment editor or the post edit route). The mounted editor keeps its
// typed values visible but can no longer submit (finding #3); closing it opens
// the way to the addendum editor. The full body is never reinterpreted as an
// addendum.
export function ExpiredFullEditNotice ({ onCancel }) {
  return (
    <div className='mt-2'>
      <div className='text-muted fw-bold'>
        {EXPIRED_FULL_EDIT_MESSAGE} Close this editor to add an informational update.
      </div>
      <Button variant='grey-medium' size='sm' className='mt-1' onClick={onCancel}>close editor</Button>
    </div>
  )
}
