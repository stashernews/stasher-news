import { Checkbox, DateTimeInput, Form, Input, SNInput, VariableInput } from '@/components/form'
import AdvPostForm from './adv-post-form'
import { MAX_POLL_CHOICE_LENGTH, MAX_POLL_NUM_CHOICES, MAX_TITLE_LENGTH } from '@/lib/constants'
import { datePivot } from '@/lib/time'
import { pollSchema } from '@/lib/validate'
import { ItemButtonBar } from './post'
import { UPSERT_POLL } from '@/fragments/payIn'
import { usePostFormShared } from './use-post-form-shared'
import DraftsMenu from './drafts-menu'
import PageLoading from './page-loading'

export function PollForm ({ item, subs, EditInfo, children }) {
  const initialOptions = item?.poll?.options.map(i => i.option)

  const { initial, onSubmit, storageKeyPrefix, schema, draftReady } = usePostFormShared({
    item,
    subs,
    mutation: UPSERT_POLL,
    schemaFn: pollSchema,
    storageKeyPrefix: 'poll',
    // draft-aware: a saved draft's choices/expiration prefill the form (they
    // live in Draft.extra; polls have no wall fields)
    extraInitialValues: ({ draft }) => {
      const draftExtra = draft?.extra ? JSON.parse(draft.extra) : {}
      return {
        options: initialOptions || (draftExtra.pollOptions?.length ? draftExtra.pollOptions : ['', '']),
        randPollOptions: item?.poll?.randPollOptions || draftExtra.randPollOptions || false,
        pollExpiresAt: item ? item.pollExpiresAt : (draftExtra.pollExpiresAt ? new Date(draftExtra.pollExpiresAt) : datePivot(new Date(), { hours: 48 }))
      }
    }
  })

  // ?draft prefill: don't mount the form until the draft query resolved
  if (!draftReady) return <PageLoading />

  return (
    <Form
      initial={initial}
      schema={schema}
      onSubmit={onSubmit}
      storageKeyPrefix={storageKeyPrefix}
    >
      {!item && <div className='d-flex justify-content-end mb-2'><DraftsMenu type='POLL' /></div>}
      {children}
      <Input
        label='title'
        name='title'
        required
        maxLength={MAX_TITLE_LENGTH}
      />
      <SNInput
        topLevel
        label={<>text <small className='text-muted ms-2'>optional</small></>}
        name='text'
        minRows={2}
      />
      <VariableInput
        label='choices'
        name='options'
        readOnlyLen={initialOptions?.length}
        max={MAX_POLL_NUM_CHOICES}
        min={2}
        hint={EditInfo}
        maxLength={MAX_POLL_CHOICE_LENGTH}
      />
      <AdvPostForm>
        <DateTimeInput
          isClearable
          label='poll expiration'
          name='pollExpiresAt'
          className='pr-4'
          groupClassName='mb-0'
        />
        <Checkbox
          label={<div className='d-flex align-items-center'>randomize order of poll choices</div>}
          name='randPollOptions'
        />
      </AdvPostForm>
      <ItemButtonBar itemId={item?.id} />
    </Form>
  )
}
