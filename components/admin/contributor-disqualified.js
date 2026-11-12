import { useEffect, useRef, useState } from 'react'
import { DISQUALIFIED_CONTRIBUTOR_POSTS } from './contributor-client'
import styles from '@/styles/admin.module.css'

const reasonLabel = reason => reason ? reason.replaceAll('_', ' ') : 'None'

export default function ContributorDisqualified ({ client, onSelectPost, revision, disabled }) {
  const [page, setPage] = useState({ total: 0, rows: [], nextCursor: null })
  const [loaded, setLoaded] = useState(false)
  const [message, setMessage] = useState('')
  const request = useRef(0)
  const paging = useRef(false)
  useEffect(() => {
    const token = ++request.current
    paging.current = true
    setMessage('')
    client.query({ query: DISQUALIFIED_CONTRIBUTOR_POSTS })
      .then(({ data }) => {
        if (token !== request.current) return
        if (!data?.adminDisqualifiedContributorPosts) throw new Error('missing result')
        setPage(data.adminDisqualifiedContributorPosts); setLoaded(true)
      })
      .catch(() => { if (token === request.current) setMessage('Could not load disqualified posts.') })
      .finally(() => { if (token === request.current) paging.current = false })
    return () => { request.current++ }
  }, [client, revision])
  const more = async () => {
    if (paging.current || !page.nextCursor) return
    paging.current = true
    const token = request.current
    try {
      const { data } = await client.query({ query: DISQUALIFIED_CONTRIBUTOR_POSTS, variables: { after: page.nextCursor } })
      if (token !== request.current) return
      const next = data.adminDisqualifiedContributorPosts
      setPage(current => ({ total: next.total, rows: [...new Map([...current.rows, ...next.rows].map(r => [r.id, r])).values()], nextCursor: next.nextCursor }))
    } catch { if (token === request.current) setMessage('Could not load more disqualified posts.') } finally { if (token === request.current) paging.current = false }
  }
  return (
    <section className={styles.card}>
      <h2>Disqualified posts</h2>
      <p>Posts currently flagged out of contributor rewards, newest flag first. Choose Review to update the reason or restore eligibility.</p>
      {message && <p role='alert'>{message}</p>}
      {loaded && !page.rows.length && <p>No posts are disqualified.</p>}
      {page.rows.length > 0 && (
        <div className={styles.contributorTable}>
          <table>
            <thead><tr><th>Post</th><th>Reason</th><th>Flagged</th><th>Author notified</th><th /></tr></thead>
            <tbody>
              {page.rows.map(p => (
                <tr key={p.id}>
                  <td>
                    <a href={`/items/${p.id}`}>#{p.id} {p.title || 'Untitled'}</a>{p.deleted && ' (deleted)'}
                    <small className={styles.contributorAuthor}>{p.authorName || `Author #${p.authorId}`}{p.note && ` · Note: ${p.note}`}</small>
                  </td>
                  <td>{reasonLabel(p.disqualificationReason)}</td>
                  <td>{p.disqualifiedAt}</td>
                  <td>{p.notifyAt ? `Yes, ${p.notifyAt}` : 'No'}</td>
                  <td><button disabled={disabled} onClick={() => onSelectPost(p.id)}>Review</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {loaded && <p>Showing {page.rows.length} of {page.total}.</p>}
      {page.nextCursor && <button disabled={disabled} onClick={more}>Load more</button>}
    </section>
  )
}
