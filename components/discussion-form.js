import { Form, Input, SNInput } from '@/components/form'
import { discussionSchema } from '@/lib/validate'
import { MAX_TITLE_LENGTH } from '@/lib/constants'
import { ItemButtonBar } from './post'
import { UPSERT_DISCUSSION } from '@/fragments/payIn'
import { usePostFormShared } from './use-post-form-shared'
import AdvPostForm from './adv-post-form'
import MoneroWallFields, { moneroWallInitialValues } from './monero-wall-form-fields'
import DraftsMenu from './drafts-menu'
import PageLoading from './page-loading'

export function DiscussionForm ({
  item, subs, EditInfo, titleLabel = 'title',
  textLabel = 'text',
  handleSubmit, children
}) {
  const { initial, onSubmit, storageKeyPrefix, schema, draftReady } = usePostFormShared({
    item,
    subs,
    mutation: UPSERT_DISCUSSION,
    storageKeyPrefix: 'discussion',
    schemaFn: discussionSchema,
    // draft-aware: a saved draft's wall amounts prefill the wall fields
    extraInitialValues: ({ draft }) => moneroWallInitialValues(item, draft)
  })

  // ?draft prefill: Formik initialValues are one-shot, so don't mount the form
  // until the draft query resolved (after all hooks)
  if (!draftReady) return <PageLoading />

  return (
    <Form
      initial={initial}
      schema={schema}
      onSubmit={handleSubmit || onSubmit}
      storageKeyPrefix={storageKeyPrefix}
    >
      {!item && <div className='d-flex justify-content-end mb-2'><DraftsMenu type='DISCUSSION' /></div>}
      {children}
      <Input
        label={titleLabel}
        name='title'
        required
        autoFocus
        clear
        maxLength={MAX_TITLE_LENGTH}
      />
      <SNInput
        topLevel
        label={<>{textLabel} <small className='text-muted ms-2'>optional</small></>}
        name='text'
        minRows={6}
        hint={EditInfo}
      />
      <AdvPostForm>
        <MoneroWallFields item={item} />
      </AdvPostForm>
      <ItemButtonBar itemId={item?.id} />
    </Form>
  )
}
