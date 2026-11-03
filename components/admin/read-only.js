import { useState } from 'react'
import { formatXmr } from '@/lib/admin/units'
import styles from '@/styles/admin.module.css'
import { AUDIT, CREATE_INVITE, REVOKE_INVITE } from './client'

export function Table ({ rows = [], columns }) {
  const value = cell => cell == null ? '—' : typeof cell === 'object' ? JSON.stringify(cell) : String(cell)
  return <div className={styles.tableScroll}><table><thead><tr>{columns.map(column => <th key={column.key} scope='col'>{column.label}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={row.id ?? row.key ?? index}>{columns.map(column => <td key={column.key}>{column.render ? column.render(row) : value(row[column.key])}</td>)}</tr>)}</tbody></table>{!rows.length && <p className={styles.empty}>No records.</p>}</div>
}

export function MaintenanceBanner () {
  return <div className={styles.banner} role='status'><strong>Maintenance is on.</strong> Public pages serve the maintenance notice. This private panel remains available.</div>
}

export function RolloutModes ({ modes }) {
  return <section className={styles.card}><h2>Rollout modes</h2><Table rows={modes} columns={[{ key: 'label', label: 'Feature' }, { key: 'storedValue', label: 'Stored' }, { key: 'effectiveValue', label: 'Effective' }]} /></section>
}

function Sparkline ({ points = [] }) {
  const amounts = points.map(point => BigInt(point.piconeros))
  const max = amounts.reduce((a, b) => a > b ? a : b, 1n)
  const coordinates = amounts.map((value, i) => `${i * 100 / Math.max(1, amounts.length - 1)},${40 - Number(value * 36n / max)}`).join(' ')
  return <figure><figcaption>Tips · last 7 days · {formatXmr(amounts.reduce((a, b) => a + b, 0n))} XMR</figcaption><svg viewBox='0 0 100 44' role='img' aria-label='Seven-day tip volume sparkline' className={styles.sparkline}><polyline points={coordinates} fill='none' stroke='currentColor' strokeWidth='1' /></svg></figure>
}

export function Overview ({ data }) {
  if (!data) return <p>Overview unavailable.</p>
  const health = data.health
  const stats = [
    ['monerod', health.stale ? 'Unknown · stale' : health.monerod ? 'Online' : 'Offline'],
    ['Monero LWS', health.stale ? 'Unknown · stale' : health.lws ? 'Online' : 'Offline'],
    ['Chain height', health.height ?? 'Unknown'], ['Chain state', health.stale ? 'Unknown' : health.stalled ? 'Stalled' : 'Advancing'],
    ['Pending tips', data.pendingTips ?? 'Unknown'], ['Failed jobs', data.failedJobs ?? 'Unknown'],
    ['Worker completion', data.workerCompletedAt ?? 'Not observed'], ['Trust walk', data.trust?.completedAt ?? 'Not observed']
  ]
  return (
    <>
      {!!data.errors?.length && <p className={styles.banner} role='status'>Unavailable sources: {data.errors.join(', ')}. Unknown values are not zero balances or healthy readings.</p>}
      <div className={styles.stats}>{stats.map(([label, value]) => <article className={styles.card} key={label}><small>{label}</small><strong>{value}</strong></article>)}</div>
      <RolloutModes modes={data.rolloutModes} />
      <section className={styles.card}>
        <h2>Treasury · database ledger</h2>
        {!data.treasury.available && <p>Treasury unavailable. No balance is assumed.</p>}
        {data.treasury.available && (
          <>
            <div className={styles.stats}>{[['Balance', 'balancePiconeros'], ['Next pool', 'nextPoolPiconeros'], ['Ops earmark', 'opsEarmarkPiconeros'], ['Outstanding rewards', 'outstandingRewardsPiconeros']].map(([label, key]) => <article key={key}><small>{label}</small><strong>{data.treasury[key].xmr} XMR</strong></article>)}</div>
            {(data.treasury.accountingUncertain || data.treasury.balanceNeedsReconciliation) && <p className={styles.warning}>Accounting needs reconciliation. Do not treat this balance as verified.</p>}
            <details><summary>Inflow by source (piconeros)</summary><Table rows={Object.entries(data.treasury.inflowBreakdown ?? {}).map(([key, value]) => ({ key, value }))} columns={[{ key: 'key', label: 'Source' }, { key: 'value', label: 'Amount / allocation' }]} /></details>
          </>
        )}
      </section>
      <div className={styles.stats}><section className={styles.card}><h2>Activity · 7 days</h2><p>{data.activity?.registrations ?? '—'} registrations · {data.activity?.posts ?? '—'} posts · {data.activity?.comments ?? '—'} comments</p><Sparkline points={data.activity?.tips} /></section><section className={styles.card}><h2>Trust & distribution</h2><p>Effective trust floor: {data.trust?.effectiveFloor ?? 'unknown'}{data.trust?.failSafeEngaged ? ' · fail-safe engaged' : ''}</p><Table rows={Object.entries(data.distribution ?? {}).map(([key, value]) => ({ key, value }))} columns={[{ key: 'key', label: 'Latest run' }, { key: 'value', label: 'Value' }]} /></section></div>
    </>
  )
}

const xmr = value => value == null ? '—' : `${formatXmr(BigInt(value))} XMR`

function Amounts ({ rows }) {
  return <div className={styles.stats}>{rows.map(([label, value, note]) => <article key={label}><small>{label}</small><strong>{value}</strong>{note && <small>{note}</small>}</article>)}</div>
}

const INFLOW_ROWS = [
  ['Downvotes', 'downvotePiconeros', 'downvoteRewardsPct'],
  ['Posting fees', 'postingFeePiconeros', 'postingFeeRewardsPct'],
  ['Turf fees', 'territoryFeePiconeros', 'territoryFeeRewardsPct'],
  ['Wallet-less tips', 'walletlessTipPiconeros', 'walletlessTipRewardsPct']
]

const LOG_COLUMNS = [
  { key: 'id', label: '#' },
  { key: 'period', label: 'Period / UTC', render: row => `${row.periodStart.slice(0, 10)} → ${row.periodEnd.slice(0, 10)}` },
  { key: 'status', label: 'Status' },
  { key: 'poolPiconeros', label: 'Pool', render: row => xmr(row.poolPiconeros) },
  { key: 'distributedPiconeros', label: 'Distributed', render: row => xmr(row.distributedPiconeros) },
  { key: 'rolledOverPiconeros', label: 'Rolled over', render: row => xmr(row.rolledOverPiconeros) },
  { key: 'reservePiconeros', label: 'Reserve', render: row => xmr(row.reservePiconeros) },
  { key: 'spendLimitPiconeros', label: 'Spend limit', render: row => xmr(row.spendLimitPiconeros) },
  { key: 'opsSweptPiconeros', label: 'Ops swept', render: row => xmr(row.opsSweptPiconeros) },
  { key: 'opsSweepState', label: 'Sweep' }
]

function DistributionDetail ({ row }) {
  const multiple = row.multBps == null ? '—' : `${row.multBps / 10000}×`
  return (
    <details>
      <summary>#{row.id} · budget, ops and payouts</summary>
      <Amounts rows={[
        ['Raw tips', xmr(row.rawTipPiconeros)], ['Eligible T (final)', xmr(row.trustedTipPiconeros)], ['Tippers', row.tipperCount ?? '—'],
        ['T4', xmr(row.tipT4Piconeros)], ['I4', xmr(row.incomeF4Piconeros)], ['Income F', xmr(row.incomePiconeros)], ['m', multiple],
        ['Dynamic budget', xmr(row.dynamicBudgetPiconeros), row.dynamicBudgetMode], ['Applied budget', xmr(row.appliedCuratorBudgetPiconeros), row.curatorBudgetMode],
        ['Make-up', xmr(row.makeupPiconeros)], ['Breaker', row.breakerTripped ? `tripped · raw ${xmr(row.breakerRawTPiconeros)}` : 'not tripped']
      ]}
      />
      <Amounts rows={[
        ['Ops inflow', xmr(row.opsInflowPiconeros)], ['Ops available', xmr(row.opsAvailablePiconeros)], ['Ops swept', xmr(row.opsSweptPiconeros), row.opsSweepState],
        ['Fees accounted', xmr(row.opsNetworkFeesAccountedPiconeros)], ['Pending ops (adjusted)', xmr(row.correctedPendingOpsPiconeros)]
      ]}
      />
      {row.opsSweepTxHash && <p className={styles.help}>Sweep tx: {row.opsSweepTxHash.split(',').join(', ')}</p>}
      <Table rows={row.payouts} columns={[{ key: 'curatorNym', label: 'Curator', render: payout => payout.curatorNym || `user #${payout.curatorId}` }, { key: 'piconeros', label: 'Amount', render: payout => xmr(payout.piconeros) }, { key: 'state', label: 'State' }, { key: 'txHash', label: 'Tx' }]} />
    </details>
  )
}

// The exact rewards-wallet ledger. Private: /transparency publishes none of it.
export function Treasury ({ data }) {
  if (!data) return <p>Treasury unavailable. No balance is assumed.</p>
  const { wallet, distributions } = data
  const inflow = wallet.inflowBreakdown
  const warnings = [
    wallet.balanceNeedsReconciliation && 'Wallet balance needs reconciliation. Do not treat it as verified.',
    BigInt(wallet.opsDeficitPiconeros) > 0n && `Ops debt is unfunded by ${xmr(wallet.opsDeficitPiconeros)}: hot-wallet fees and sweeps exceed the ops earmark.`,
    wallet.accountingUncertain && 'Accounting is uncertain: unresolved journal attempts or conflicting ledger facts. Figures may be incomplete.'
  ].filter(Boolean)
  return (
    <>
      <p>Exact figures from the database ledger. None of this is published; /transparency shows only trends, shares and counts.</p>
      <section className={styles.card}>
        <h2>Live balance · database ledger</h2>
        <Amounts rows={[
          ['Balance', xmr(wallet.balancePiconeros), 'received − principal − fees'], ['Total received', xmr(wallet.totalReceivedPiconeros)],
          ['Total sent', xmr(wallet.totalSentPiconeros), 'payouts + ops sweeps'], ['Network fees', xmr(wallet.totalNetworkFeesPiconeros), 'paid by ops'],
          ['Rewards owed', xmr(wallet.outstandingRewardsPiconeros), 'allocated, not delivered']
        ]}
        />
        {warnings.map(warning => <p className={styles.warning} key={warning}>{warning}</p>)}
        <p className={styles.help}>{wallet.reconciliationEvidenceCurrent
          ? `Ledger matches the latest reconciliation check (${wallet.reconciliationCheckedAt}).`
          : wallet.reconciliationCheckedAt
            ? `The latest reconciliation check (${wallet.reconciliationCheckedAt}) no longer matches the ledger.`
            : 'No full-wallet reconciliation check has been published yet.'}
        </p>
      </section>
      <section className={styles.card}>
        <h2>Current allocation</h2>
        <Amounts rows={[
          ['Rewards pool', xmr(wallet.nextPoolPiconeros), 'next run, incl. future weeks'], ['Ops awaiting sweep', xmr(wallet.pendingSweepPiconeros), 'negative is unfunded debt'],
          ['Paid to curators · all-time', xmr(wallet.payoutSentPiconeros)], ['Swept to ops · all-time', xmr(wallet.sweptToOpsPiconeros)]
        ]}
        />
      </section>
      <section className={styles.card}>
        <h2>Confirmed inflow by source · all-time</h2>
        <Table
          rows={[
            ...INFLOW_ROWS.map(([label, key, pct]) => ({ key: label, source: label, amount: xmr(inflow[key]), split: `${inflow[pct]}% to rewards` })),
            { key: 'total', source: 'Total', amount: xmr(inflow.totalPiconeros), split: `rewards ${xmr(inflow.rewardsPiconeros)} · ops ${xmr(inflow.opsPiconeros)}` }
          ]}
          columns={[{ key: 'source', label: 'Source' }, { key: 'amount', label: 'Amount' }, { key: 'split', label: 'Allocation' }]}
        />
      </section>
      <section className={styles.card}>
        <h2>Distribution log · last {distributions.length}</h2>
        <div className={styles.ledgerTable}><Table rows={distributions} columns={LOG_COLUMNS} /></div>
        {distributions.map(row => <DistributionDetail key={row.id} row={row} />)}
      </section>
    </>
  )
}

export function AuditLog ({ initial, client }) {
  const [extra, setExtra] = useState([])
  const [cursor, setCursor] = useState(initial.nextCursor)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const more = async () => {
    setBusy(true)
    try {
      const { data } = await client.query({ query: AUDIT, variables: { cursor } })
      setExtra([...extra, ...data.adminAudit.rows]); setCursor(data.adminAudit.nextCursor)
    } catch { setError('Could not load the next audit page.') } finally { setBusy(false) }
  }
  return <><p>Private append-only history. Times are UTC. Nothing here is published.</p><Table rows={[...initial.rows, ...extra]} columns={[{ key: 'createdAt', label: 'Time / UTC' }, { key: 'field', label: 'Field' }, { key: 'oldValue', label: 'Old' }, { key: 'newValue', label: 'New' }, { key: 'reason', label: 'Reason' }, { key: 'applied', label: 'Applied' }, { key: 'applyId', label: 'Apply id' }]} />{error && <p role='alert'>{error}</p>}{cursor && <button onClick={more} disabled={busy}>{busy ? 'Loading…' : 'Older changes'}</button>}</>
}

export function InviteCodes ({ rows, client, onRefresh }) {
  const [label, setLabel] = useState('')
  const [reason, setReason] = useState('')
  const [code, setCode] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const execute = async (query, variables) => {
    setBusy(true); setError('')
    try {
      const { data } = await client.mutate({ mutation: query, variables })
      const result = data.adminCreateInviteCode ?? data.adminRevokeInviteCode
      if (result.code) { setCode(result.code); setLabel('') }
      if (!result.alertDelivered) setError('Change committed, but alert delivery failed. Check the audit and alert channel.')
      setReason(''); await onRefresh()
    } catch (err) { setError(err.message || 'Invite action failed.') } finally { setBusy(false) }
  }
  return <section className={styles.card}><h2>Invite gate & codes</h2><p>The gate is on while any active DB or environment code exists. Revoking the last DB code turns it off only if no env code remains. Other processes refresh within 60 seconds.</p>{code && <div className={styles.banner}><strong>Shown once. Save this code now.</strong><code className={styles.oneTimeCode}>{code}</code><button onClick={async () => { try { await navigator.clipboard.writeText(code) } catch { setError('Clipboard unavailable. Select and copy the code manually.') } }}>Copy code</button><button onClick={() => setCode(null)}>Dismiss code</button></div>}<label htmlFor='invite-reason'>Reason for create / revoke</label><input id='invite-reason' value={reason} maxLength={500} onInput={event => setReason(event.currentTarget.value)} /><Table rows={rows} columns={[{ key: 'label', label: 'Label' }, { key: 'source', label: 'Source' }, { key: 'createdAt', label: 'Created / UTC' }, { key: 'revokedAt', label: 'Revoked / UTC' }, { key: 'action', label: 'Action', render: row => row.source === 'env' ? 'Read-only' : row.revokedAt ? 'Revoked' : <button disabled={busy || !reason.trim()} onClick={() => execute(REVOKE_INVITE, { id: row.id, reason })}>Revoke {row.label}</button> }]} /><form onSubmit={event => { event.preventDefault(); if (reason.trim() && label.trim()) execute(CREATE_INVITE, { label, reason }) }}><label htmlFor='invite-label'>New code label</label><input id='invite-label' value={label} maxLength={100} onInput={event => setLabel(event.currentTarget.value)} /><button type='submit' disabled={busy || !label.trim() || !reason.trim()}>Create code</button></form>{error && <p role='alert' className={styles.warning}>{error}</p>}</section>
}
