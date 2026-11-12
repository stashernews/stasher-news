import { useCallback, useEffect, useRef, useState } from 'react'
import { CONTRIBUTOR_POST, SET_CONTRIBUTOR_ELIGIBILITY } from './contributor-client'
import { ReviewDialog } from './review-dialog'
import styles from '@/styles/admin.module.css'

export function parseContributorPostId (input, origin, publicUrl = process.env.NEXT_PUBLIC_URL) {
  let raw = input.trim()
  if (!/^\d+$/.test(raw)) {
    const url = new URL(raw, origin)
    const trustedOrigins = [origin]
    try {
      const configured = new URL(publicUrl)
      if (['http:', 'https:'].includes(configured.protocol)) trustedOrigins.push(configured.origin)
    } catch {}
    if (!trustedOrigins.includes(url.origin) || !/^\/items\/\d+$/.test(url.pathname)) throw new Error('Enter a site post URL or ID.')
    raw = url.pathname.split('/').pop()
  }
  const id = Number(raw)
  if (!Number.isInteger(id) || id < 1 || id > 2147483647) throw new Error('Enter a valid post ID.')
  return id
}

export default function ContributorEligibility ({ client, selectedPostId, selectionRevision, onCommitted, disabled = false, onActivityChange }) {
  const [input, setInput] = useState('')
  const [post, setPost] = useState(null)
  const [category, setCategory] = useState('PLAGIARISM')
  const [note, setNote] = useState('')
  const [notify, setNotify] = useState(false)
  const [review, setReview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [reviewError, setReviewError] = useState('')
  const request = useRef(0)
  const submitting = useRef(false)
  const closeReview = useCallback(() => { setReview(null); setReviewError('') }, [])
  const openReview = disqualify => { setReviewError(''); setReview(disqualify) }
  useEffect(() => { onActivityChange?.(review !== null || busy); return () => onActivityChange?.(false) }, [review, busy, onActivityChange])
  const load = useCallback(async id => {
    const token = ++request.current
    setLoading(true); setPost(null); setReview(null); setNotify(false)
    try {
      const { data } = await client.query({ query: CONTRIBUTOR_POST, variables: { id } })
      if (token !== request.current) return
      setPost(data.adminContributorPost)
      setCategory(data.adminContributorPost?.disqualificationReason || 'PLAGIARISM')
      setNote(data.adminContributorPost?.note || '')
      if (!data.adminContributorPost) setMessage('Post not found.')
    } catch (error) { if (token === request.current) setMessage(error.message || 'Could not load post.') } finally { if (token === request.current) setLoading(false) }
  }, [client])
  useEffect(() => { if (selectedPostId) { setInput(String(selectedPostId)); load(selectedPostId) } return () => { request.current++ } }, [selectedPostId, selectionRevision, load])
  const lookup = event => {
    event.preventDefault()
    if (disabled || busy || loading || review !== null) return
    setMessage('')
    try { load(parseContributorPostId(input, window.location.origin)) } catch (error) { setMessage(error.message) }
  }
  const apply = async (_changes, reason) => {
    if (submitting.current || !post || review == null) return
    submitting.current = true; setBusy(true); setMessage(''); setReviewError('')
    try {
      const { data } = await client.mutate({ mutation: SET_CONTRIBUTOR_ELIGIBILITY, variables: { id: post.id, expectedVersion: post.version, disqualified: review, disqualificationReason: review ? category : null, note: review ? note : null, notifyAuthor: review && notify, reason } })
      const result = data.adminSetContributorEligibility
      setReview(null)
      setMessage(result.alertDelivered ? 'Eligibility committed, audited and announced.' : 'Eligibility committed, but operator alert delivery failed. Check the audit and alert channel.')
      await load(post.id)
      try { await onCommitted?.() } catch { setMessage('Eligibility committed. Could not refresh the dashboard; check the audit before retrying.') }
    } catch (error) {
      const code = (error.errors?.[0]?.extensions ?? error.graphQLErrors?.[0]?.extensions)?.code
      // Refused before writing: keep the dialog and the operator's choices,
      // and show why where they are looking.
      if (['VALIDATION_ERROR', 'ALERTS_NOT_CONFIGURED', 'FORBIDDEN', 'BAD_USER_INPUT', 'GRAPHQL_VALIDATION_FAILED'].includes(code)) {
        setReviewError(error.message.startsWith('Nothing was applied') ? error.message : 'Nothing was applied. ' + error.message)
        return
      }
      setReview(null)
      if (code === 'STALE_VALUE') setMessage('Post eligibility changed. Reload and review before applying.')
      else setMessage('Could not confirm the result. Reload the post and inspect the audit before retrying. ' + error.message)
      await load(post.id)
    } finally { submitting.current = false; setBusy(false) }
  }
  const change = (label, expected, value) => ({ field: { key: label, label, section: 'rewards', type: 'text' }, expected, value, jump: false })
  const changes = post && review != null
    ? [
        change(`Post #${post.id}`, post.title || 'Untitled', post.title || 'Untitled'),
        change('Eligibility', post.disqualifiedAt ? 'Disqualified' : 'No flag', review ? 'Disqualified' : 'Flag cleared'),
        change('Reason shown to author', post.disqualificationReason || 'None', review ? category : 'None'),
        change('Private note', post.note || 'None', review ? note || 'None' : 'None'),
        change('Author notification', 'Not requested', review && notify ? 'Yes' : 'No')
      ]
    : []
  return (
    <section className={styles.card}>
      <h2>Post eligibility</h2>
      <p>Changes affect future selection only. Provisional public lists may take five minutes to refresh. Past rewards and visibility are unchanged.</p>
      {!post && message && <p role='status'>{message}</p>}
      <form onSubmit={lookup}><label>Post URL or ID<input value={input} onInput={e => setInput(e.currentTarget.value)} /></label><button disabled={disabled || busy || loading || review !== null}>Load post</button></form>
      {loading && <p>Loading post...</p>}
      {post && (
        <fieldset disabled={disabled || busy || review !== null}>
          <legend><a href={`/items/${post.id}`}>#{post.id} {post.title || 'Untitled'}</a></legend>
          <p>Author: {post.authorName || `#${post.authorId}`} · {post.deleted ? 'Deleted' : post.disqualifiedAt ? 'Disqualified' : 'No disqualification flag'}</p>
          <p>Last author notice requested: {post.notifyAt || 'None'}</p>
          <label>Disqualification reason<select value={category} onChange={e => setCategory(e.currentTarget.value)}>{['PLAGIARISM', 'AI_GENERATED', 'RULES', 'OTHER'].map(r => <option key={r} value={r}>{r.replaceAll('_', ' ')}</option>)}</select></label>
          <label>Private note<textarea value={note} maxLength={2000} onInput={e => setNote(e.currentTarget.value)} /></label>
          <label className={styles.checkLabel}><input name='notifyAuthor' type='checkbox' checked={notify} onChange={e => setNotify(e.currentTarget.checked)} /> Notify author</label>
          <p className={styles.help}>Show an in-app notice with the selected reason. Your private note is never shown. {post.notifyAt && 'Leaving this unchecked does not remove an existing notice.'}</p>
          <div className={styles.actions}><button data-action='disqualify' disabled={post.deleted} onClick={() => openReview(true)}>{post.disqualifiedAt ? 'Review flag update' : 'Review disqualification'}</button>{post.disqualifiedAt && <button onClick={() => { setNotify(false); openReview(false) }}>Review restoration</button>}</div>
        </fieldset>
      )}
      {post && message && <p role='status'>{message}</p>}
      {review !== null && <ReviewDialog changes={changes} busy={busy} onClose={closeReview} onApply={apply} error={reviewError} />}
    </section>
  )
}
