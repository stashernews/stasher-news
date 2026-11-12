import { useEffect, useRef, useState } from 'react'
import { CONTRIBUTOR_RUNS, CONTRIBUTOR_SNAPSHOT } from './contributor-client'
import { piconerosToXmr } from '@/lib/format'
import styles from '@/styles/admin.module.css'

const missing = value => value ?? 'Not recorded'
const amount = value => value == null ? 'Not recorded' : piconerosToXmr(BigInt(value))
const metricLabels = { tippers: 'Counting tippers', trustedTippers: 'Trusted tippers', base: 'Tip base after caps and downvotes', breadth: 'Breadth multiplier', commenters: 'Counted trusted commenters', commentMultiplier: 'Comment multiplier', score: 'Score', words: 'Effective words', lengthMultiplier: 'Length multiplier', weight: 'Payout weight' }

function ScoringBreakdown ({ post, onSelectPost, disabled }) {
  const accounts = post.trustedTipperAccounts
  return (
    <details>
      <summary>Scoring breakdown</summary>
      <dl>{Object.entries(metricLabels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{missing(post[key])}</dd></div>)}</dl>
      <h4>Trusted tipper accounts</h4>
      {accounts == null
        ? <p>Trusted tipper identities were not recorded or the saved list is incomplete.</p>
        : accounts.length === 0
          ? <p>No trusted tippers counted for this post.</p>
          : <><ul>{accounts.map(account => <li key={account.id}>{account.name ? <a href={`/${encodeURIComponent(account.name)}`}>@{account.name}</a> : `Account #${account.id} (unavailable)`}</li>)}</ul><p>Trust was determined when the run was scored. Account names are current.</p></>}
      <p>Before limits: {amount(post.rawShare)}</p>
      {post.trims.map((t, i) => <p key={i}>{t.rule}: {amount(t.piconeros)}</p>)}
      <button disabled={!post.available || disabled} onClick={() => onSelectPost(post.itemId)}>Review current eligibility</button>
    </details>
  )
}

export function ContributorSnapshotView ({ run, onSelectPost, disabled }) {
  const award = run.mode === 'SHADOW' ? 'Would allocate' : 'Allocated'
  return (
    <>
      <h3>Run #{run.id} · {run.mode} · {run.status}</h3>
      <p>Distribution: {missing(run.periodEnd)} · Configured mode: {missing(run.configuredMode)}</p>
      <p>UTC window: {missing(run.windowStart)} to {missing(run.windowEnd)} (end exclusive). {run.windowScored === false && 'Not marked scored; eligible for catch-up.'}</p>
      <p>Checked: {missing(run.candidates)} · Eligible: {missing(run.eligible)} · Qualified: {missing(run.qualifying)} · Near misses: {missing(run.nearMisses)} · Catch-up weeks: {missing(run.catchUpWeeks)}</p>
      <p>{award}: {amount(run.allocation?.paid)} · Unallocated: {amount(run.allocation?.rolledOver)} · Applied budget: {amount(run.appliedBudget)}</p>
      <p>Winner cap: {amount(run.allocation?.winnerCap)} · Combined cap: {amount(run.allocation?.combinedCap)} · Fit (basis points): {missing(run.funding?.fitBps)} · Scaled: {run.funding?.scaled == null ? 'Not recorded' : run.funding.scaled ? 'Yes' : 'No'}</p>
      <p>Recorded scored rows: {run.recordedRows}. This is not the full list of posts checked. Titles and author names are current, not historical. Allocations do not prove payment delivery.</p>
      {run.errors.map(e => <p role='alert' key={e}>{e}</p>)}
      {run.warnings.map(w => <p key={w}>{w}</p>)}
      <details><summary>Recorded configuration and funding</summary><dl>{run.parameters.map(p => <div key={p.key}><dt>{p.key}</dt><dd>{p.value}</dd></div>)}</dl><dl>{['curatorTarget', 'contributorTarget', 'room', 'curatorBudget', 'contributorBudget'].map(key => <div key={key}><dt>{key}</dt><dd>{amount(run.funding?.[key])}</dd></div>)}</dl></details>
      <details><summary>Exclusion counts</summary>{run.exclusions.map(e => <p key={e.reason}>{e.reason}: {e.count}</p>)}</details>
      <div className={styles.contributorTable}>
        <table>
          <thead><tr><th>Selected rank</th><th>Post</th><th>Trusted tippers</th><th>Score</th><th>Words</th><th>{award}</th><th>Details</th></tr></thead>
          <tbody>
            {run.posts.map(p => <tr key={p.itemId}><td>{p.rank ?? (p.qualifies == null ? 'Not recorded' : p.qualifies ? 'Qualified, not selected' : 'Not selected')}</td><td>{p.available ? <a href={`/items/${p.itemId}`}>{p.title || `Post #${p.itemId}`}</a> : `Post unavailable (#${p.itemId})`}<small className={styles.contributorAuthor}>{p.authorName || `Author #${p.authorId}`} · {missing(p.turf)}</small></td><td>{missing(p.trustedTippers)}</td><td>{missing(p.score)}</td><td>{missing(p.words)}</td><td>{amount(p.share)}</td><td><ScoringBreakdown post={p} onSelectPost={onSelectPost} disabled={disabled} /></td></tr>)}
          </tbody>
        </table>
      </div>
      {!run.posts.length && <p>No scored rows were recorded for this run.</p>}
    </>
  )
}

export default function ContributorSnapshots ({ client, onSelectPost, revision, disabled }) {
  const [page, setPage] = useState({ rows: [], nextBeforeId: null })
  const [run, setRun] = useState(null)
  const [id, setId] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const request = useRef(0)
  const historyRequest = useRef(0)
  const paging = useRef(false)
  useEffect(() => {
    const token = ++historyRequest.current
    paging.current = true
    setMessage('')
    client.query({ query: CONTRIBUTOR_RUNS })
      .then(({ data }) => { if (token === historyRequest.current) setPage(data.adminContributorRuns) })
      .catch(() => { if (token === historyRequest.current) setMessage('Could not load run history.') })
      .finally(() => { if (token === historyRequest.current) paging.current = false })
    return () => { historyRequest.current++ }
  }, [client, revision])
  useEffect(() => () => { request.current++ }, [client])
  const loadRun = async value => {
    setId(value); setRun(null); setMessage('')
    const token = ++request.current
    if (!value) { setLoading(false); return }
    setLoading(true)
    try {
      const { data } = await client.query({ query: CONTRIBUTOR_SNAPSHOT, variables: { id: Number(value) } })
      if (token === request.current) { setRun(data.adminContributorSnapshot); if (!data.adminContributorSnapshot) setMessage('Run not found.') }
    } catch { if (token === request.current) setMessage('Could not load snapshot.') } finally { if (token === request.current) setLoading(false) }
  }
  const more = async () => {
    if (paging.current || !page.nextBeforeId) return
    paging.current = true
    const token = historyRequest.current
    try {
      const { data } = await client.query({ query: CONTRIBUTOR_RUNS, variables: { beforeId: page.nextBeforeId } })
      if (token !== historyRequest.current) return
      setPage(current => ({ rows: [...new Map([...current.rows, ...data.adminContributorRuns.rows].map(r => [r.id, r])).values()], nextBeforeId: data.adminContributorRuns.nextBeforeId }))
    } catch { if (token === historyRequest.current) setMessage('Could not load older runs.') } finally { if (token === historyRequest.current) paging.current = false }
  }
  return (
    <section className={styles.card}>
      <h2>Contributor run snapshots</h2><p>Read-only recorded results. This does not recalculate scores.</p>
      <label>Recorded run<select value={id} onChange={e => loadRun(e.currentTarget.value)}><option value=''>Choose a run</option>{page.rows.map(r => <option key={r.id} value={r.id}>#{r.id} · {r.periodEnd} · {r.mode}</option>)}</select></label>
      {page.nextBeforeId && <button onClick={more}>Load older runs</button>}
      {message && <p role='alert'>{message}</p>}{loading && <p>Loading snapshot...</p>}
      {!page.rows.length && <p>No recorded contributor runs available.</p>}
      {run && <ContributorSnapshotView run={run} onSelectPost={onSelectPost} disabled={disabled} />}
    </section>
  )
}
