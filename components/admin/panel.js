import { useCallback, useEffect, useMemo, useState } from 'react'
import { createAdminClient, DASHBOARD, APPLY } from './client'
import { FieldRow } from './field-row'
import { pendingChanges, reconcileDrafts, fieldError } from './drafts'
import { ReviewDialog } from './review-dialog'
import { Overview, Table, MaintenanceBanner, InviteCodes, AuditLog } from './read-only'
import styles from '@/styles/admin.module.css'

export function Sidebar ({ sections, active, onSelect, changes }) {
  return (
    <nav className={styles.sidebar} aria-label='Admin sections'>
      <small>OPERATOR CONSOLE</small>
      {sections.map(section => {
        const count = changes.filter(change => change.field.section === section.id).length
        return <button key={section.id} aria-current={active === section.id ? 'page' : undefined} onClick={() => onSelect(section.id)}><span>{section.label}</span>{count > 0 && <span className={styles.tag}>{count}</span>}</button>
      })}
      <p className={styles.help}>Private by design.<br />SSH authenticates this panel.<br />No account session required.</p>
    </nav>
  )
}

export function PendingBar ({ changes, invalid, errors = [], busy, onDiscard, onReview }) {
  const overLimit = changes.length > 50
  return (
    <div className={styles.pending}>
      <div><strong>{changes.length} pending change{changes.length === 1 ? '' : 's'}</strong><small>{invalid ? ` · ${invalid} invalid` : 'Not saved yet · review before applying'}</small>{overLimit && <p role='alert'>Apply supports at most 50 changes. Revert some edits and apply in batches.</p>}{errors.map(error => <p className={styles.warning} role='alert' key={error}>{error}</p>)}</div>
      <div className={styles.actions}><button disabled={busy} onClick={onDiscard}>Discard all</button><button className={styles.primary} disabled={busy || invalid > 0 || overLimit} onClick={onReview}>Review & apply</button></div>
    </div>
  )
}

export function AdminPanel () {
  const client = useMemo(() => createAdminClient(), [])
  const [data, setData] = useState(null)
  const [active, setActive] = useState('overview')
  const [drafts, setDrafts] = useState({})
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [review, setReview] = useState(false)
  const closeReview = useCallback(() => setReview(false), [])
  const refresh = useCallback(async () => {
    const result = await client.query({ query: DASHBOARD })
    setData(result.data)
    return result.data
  }, [client])
  useEffect(() => {
    refresh().catch(() => setMessage('Could not load the private API. Check the tunnel and Refresh.'))
    return () => client.stop()
  }, [client, refresh])
  const fields = data?.adminSections.flatMap(section => section.fields) ?? []
  const changes = pendingChanges(fields, drafts)
  const crossErrors = [...new Set(changes.filter(change => change.error && !fieldError(change.field, change.value)).map(change => change.error))]
  const invalid = changes.filter(change => fieldError(change.field, change.value)).length + crossErrors.length
  const section = data?.adminSections.find(section => section.id === active)
  const maintenance = fields.find(field => field.key === 'maintenance')?.value === 'true'
  const edit = (field, value) => setDrafts(current => {
    const next = { ...current }
    if (value === field.value) delete next[field.key]
    else next[field.key] = { expected: current[field.key]?.expected ?? field.value, value }
    return next
  })
  const apply = async (changes, reason) => {
    setBusy(true); setMessage('')
    try {
      const { data } = await client.mutate({ mutation: APPLY, variables: { changes, reason } })
      const result = data.adminApply
      setDrafts({}); setReview(false)
      setMessage(result.error ?? (result.alertDelivered ? 'Changes committed, audited and announced.' : 'Changes committed, but alert delivery failed. Check the audit and alert channel.'))
      await refresh()
    } catch (error) {
      const details = error.errors?.[0]?.extensions ?? error.graphQLErrors?.[0]?.extensions
      if (details?.code === 'STALE_VALUE') {
        try {
          await refresh()
          setDrafts(current => reconcileDrafts(current, details.keys ?? []))
          setReview(false)
          setMessage(`Live values changed for: ${(details.keys ?? []).join(', ')}. Conflicting edits were cleared; other edits are preserved.`)
        } catch {
          setMessage('Could not reload changed values. Nothing was applied; all edits are preserved. Close review, reconnect and Refresh before trying again.')
        }
      } else setMessage(error.message || 'Apply failed. Refresh and inspect the audit before retrying.')
    } finally { setBusy(false) }
  }
  const manualRefresh = async () => { setLoading(true); try { await refresh() } catch { setMessage('Refresh failed. Existing values may be stale.') } finally { setLoading(false) } }
  return (
    <div className={styles.shell}>
      <header className={styles.topbar}><div><span className={styles.brand}>STASHER<span> / ADMIN</span></span><small>RUNTIME CONTROL · PRIVATE</small></div><div className={styles.actions}><span className={styles.connection}>SSH-TUNNEL</span><button disabled={loading || busy} onClick={manualRefresh}>{loading ? 'Refreshing…' : 'Refresh'}</button></div></header>
      {maintenance && <MaintenanceBanner />}
      {message && <div className={styles.notice} role='status'>{message}</div>}
      {!data && <main className={styles.workspace}><h1>Operator console</h1><p>Loading private configuration…</p></main>}
      {data && (
        <div className={styles.layout}>
          <Sidebar sections={data.adminSections} active={active} onSelect={setActive} changes={changes} />
          <main className={styles.workspace}>
            <label className={styles.mobileNav}>Section<select value={active} onChange={event => setActive(event.target.value)}>{data.adminSections.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
            <div className={styles.heading}><div><small>CONTROL ROOM / {section?.id.toUpperCase()}</small><h1>{section?.label}</h1></div><small>{data.adminOverview?.fetchedAt ? `As of ${new Date(data.adminOverview.fetchedAt).toLocaleTimeString()}` : 'Manual refresh only'}</small></div>
            {active === 'overview' && <Overview data={data.adminOverview} />}
            {section?.kind === 'settings' && section.groups.map(group => <section className={styles.card} key={group}><h2>{group}</h2>{section.fields.filter(field => field.group === group).map(field => <FieldRow key={field.key} field={field} draft={drafts[field.key]} onChange={value => edit(field, value)} onRevert={() => edit(field, field.value)} />)}{group === 'Invite codes' && <InviteCodes rows={data.adminInviteCodes} client={client} onRefresh={refresh} />}</section>)}
            {active === 'access' && <><Table rows={data.adminAccess} columns={[{ key: 'label', label: 'Check' }, { key: 'pass', label: 'Result', render: row => row.pass ? 'PASS' : 'FAIL / UNKNOWN' }, { key: 'detail', label: 'Detail' }, { key: 'checkedAt', label: 'Last check / UTC' }]} /><p>SSH hardening: key-only authentication, a passphrase or hardware-backed key, and no root login. Change account login methods separately, never through this panel.</p></>}
            {active === 'environment' && <Table rows={data.adminEnvironment} columns={[{ key: 'key', label: 'Name' }, { key: 'value', label: 'Effective value / presence' }, { key: 'source', label: 'Source' }, { key: 'help', label: 'Why read-only' }]} />}
            {active === 'audit' && <AuditLog key={data.adminOverview?.fetchedAt ?? 'initial'} initial={data.adminAudit} client={client} />}
          </main>
        </div>
      )}
      {changes.length > 0 && <PendingBar changes={changes} invalid={invalid} errors={crossErrors} busy={busy} onDiscard={() => setDrafts({})} onReview={() => { setMessage(''); setReview(true) }} />}
      {review && <ReviewDialog changes={changes} busy={busy} onClose={closeReview} onApply={apply} error={message} />}
    </div>
  )
}
