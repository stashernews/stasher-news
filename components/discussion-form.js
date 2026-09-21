import { Form, Input, SNInput } from '@/components/form'
import { discussionSchema } from '@/lib/validate'
import { MAX_TITLE_LENGTH } from '@/lib/constants'
import { ItemButtonBar } from './post'
import { UPSERT_DISCUSSION } from '@/fragments/payIn'
import { usePostFormShared } from './use-post-form-shared'
import AdvPostForm from './adv-post-form'
import MoneroWallFields, { moneroWallInitialValues } from './monero-wall-form-fields'

export function DiscussionForm ({
  item, subs, EditInfo, titleLabel = 'title',
  textLabel = 'text',
  handleSubmit, children
}) {
  const { initial, onSubmit, storageKeyPrefix, schema } = usePostFormShared({
    item,
    subs,
    mutation: UPSERT_DISCUSSION,
    storageKeyPrefix: 'discussion',
    schemaFn: discussionSchema,
    extraInitialValues: moneroWallInitialValues(item)
  })
  return (
    <Form
      initial={initial}
      schema={schema}
      onSubmit={handleSubmit || onSubmit}
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
