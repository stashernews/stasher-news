import { gql } from 'graphql-tag'
import { Col, Row } from 'react-bootstrap'
import { getGetServerSideProps } from '@/api/ssrApollo'
import Layout from '@/components/layout'
import CopyChip from '@/components/copy-chip'
import PageLoading from '@/components/page-loading'
import { useQuery } from '@apollo/client/react'
import { useData } from '@/components/use-data'
import { SSR, FAST_POLL_INTERVAL_MS } from '@/lib/constants'
import { formatShare, piconerosToXmr } from '@/lib/format'
import { copyDrawdownWeeks, formatMultiple } from '@/lib/curatorBudgetCopy'
import { CURATOR_FALLBACK_CAP_PICONEROS } from '@/lib/rewardsAccounting'
import { poolStatusClass, runwayLabel } from '@/components/pool-health'

const REWARDS_WALLET = gql`
  query rewardsWalletInfo {
    rewardsWalletInfo {
      address
      viewKey
      network
      balanceNeedsReconciliation
      accountingUncertain
      reconciliationCheckedAt
      reconciliationEvidenceCurrent
      opsUnderfunded
      outstandingRewards
      inflowMix {
        downvoteBps
        postingFeeBps
        territoryFeeBps
        walletlessTipBps
        otherBps
        rewardsShareBps
        downvoteRewardsPct
        postingFeeRewardsPct
        territoryFeeRewardsPct
        walletlessTipRewardsPct
      }
    }
    curatorBudget {
      mode
      targetMultBps
      drawdownWeeks
    }
    rewardsPoolHealth {
      status
      runway
      curatorShareBps
      distributionCount
      payoutCount
      curatorCount
      deliveredPayoutBps
      medianPayoutPiconeros
    }
    rewardDistributions(limit: 10) {
      id
      periodStart
      periodEnd
      distributedPiconeros
      payoutCount
      status
      completedAt
      opsSweepTxHash
      opsSweepState
      rawTipPiconeros
      trustedTipPiconeros
      tipperCount
      breakerTripped
      breakerRawTPiconeros
      makeupPiconeros
      tipT4Piconeros
      multBps
      dynamicBudgetPiconeros
      dynamicBudgetMode
      curatorBudgetMode
      appliedCuratorBudgetPiconeros
      eligibleTipStages
      payouts {
        id
        curatorId
        curatorNym
        piconeros
        amountXmr
        txHash
        state
      }
    }
  }
`

export const getServerSideProps = getGetServerSideProps({ query: REWARDS_WALLET })

function explorerFor (network) {
  return network === 'MAINNET' ? 'https://xmrchain.net/' : 'https://stagenet.xmrchain.net/'
}

function explorerTxUrl (network) {
  return network === 'MAINNET' ? 'https://xmrchain.net/tx/' : 'https://stagenet.xmrchain.net/tx/'
}

// GraphQL BigInt serializes safe integers as JS Numbers, so wire values may
// arrive as number, string, or bigint; normalize at the view boundary.
function toBigInt (v) {
  return typeof v === 'bigint' ? v : BigInt(v)
}

function xmrOrDash (value) {
  return value == null ? '—' : piconerosToXmr(toBigInt(value))
}

// The distribution table renders a missing multiple as a dash.
function formatMultipleOrDash (multBps) {
  return formatMultiple(multBps) ?? '—'
}

export { DEFAULT_DRAWDOWN_WEEKS } from '@/lib/curatorBudgetCopy'

function shareOrDash (bps) {
  return bps == null ? '—' : formatShare(bps)
}

// One decimal, rounded down, so 99.6% never reads as a clean 100%.
function deliveredShare (bps) {
  return bps == null ? '—' : `${Math.floor(bps / 10) / 10}%`
}

const OUTSTANDING_LABELS = {
  NONE: { text: 'none owed', className: 'text-success' },
  COVERED: { text: 'covered', className: 'text-success' },
  UNCOVERED: { text: 'not covered', className: 'text-danger' }
}

// The pie palette from components/charts.js, without pulling in recharts.
const MIX_COLORS = ['var(--bs-secondary)', 'var(--bs-info)', 'var(--bs-success)', 'var(--bs-boost)', 'var(--theme-grey)']

const MIX_ROWS = [
  ['downvoteBps', 'downvotes', 'downvoteRewardsPct'],
  ['postingFeeBps', 'posting fees', 'postingFeeRewardsPct'],
  ['territoryFeeBps', 'turf fees', 'territoryFeeRewardsPct'],
  ['walletlessTipBps', 'wallet-less tips', 'walletlessTipRewardsPct'],
  ['otherBps', 'other', null]
]

function InflowMix ({ mix }) {
  const rows = MIX_ROWS.filter(([key]) => mix[key] > 0)
  if (rows.length === 0) {
    return <Stat label='No confirmed inflow yet' value='—' />
  }
  return (
    <>
      <div className='d-flex rounded overflow-hidden my-2' style={{ height: 10 }}>
        {rows.map(([key], i) => (
          <div key={key} style={{ width: `${mix[key] / 100}%`, background: MIX_COLORS[i] }} />
        ))}
      </div>
      <div className='d-flex flex-wrap justify-content-between'>
        {rows.map(([key, label, pctKey], i) => (
          <Stat
            key={key}
            label={<><span style={{ color: MIX_COLORS[i] }}>■</span> {label}</>}
            value={formatShare(mix[key])}
            sub={pctKey ? `${mix[pctKey]}% to rewards` : undefined}
          />
        ))}
      </div>
    </>
  )
}

function stageXmr (stages, key) {
  const value = stages?.[key]
  return value == null ? null : piconerosToXmr(toBigInt(value))
}

const DISTRIBUTION_STAGE_ROWS = [
  ['raw', 'Raw tips'],
  ['eligible', 'Eligible tips'],
  ['afterExclusions', 'After exclusions'],
  ['ranked', 'Ranked'],
  ['handicapped', 'Founder handicap'],
  ['trusted', 'Trust weighted'],
  ['capped', 'Per-tipper cap'],
  ['final', 'Final T']
]

function opsSweepLabel (state) {
  switch (state) {
    case 'SWEPT': return 'swept to ops wallet'
    case 'SKIPPED_LOCKED': return 'deferred (locked change)'
    case 'FAILED': return 'sweep failed (rolls over)'
    case 'NOT_SWEEPED': return 'not swept (rolls over)'
    default: return 'not swept'
  }
}

function WalletField ({ label, value }) {
  return (
    <div className='d-flex flex-column my-2'>
      <span className='text-muted fw-bold'>{label}</span>
      <span className='text-monospace text-break'>
        <CopyChip value={value}>{value}</CopyChip>
      </span>
    </div>
  )
}

function Stat ({ label, value, sub }) {
  return (
    <div className='d-flex flex-column my-2'>
      <span className='text-muted'>{label}</span>
      <span className='text-monospace'>{value}</span>
      {sub && <small className='text-muted'>{sub}</small>}
    </div>
  )
}

export default function Transparency ({ ssrData }) {
  const { data } = useQuery(
    REWARDS_WALLET,
    SSR ? {} : { pollInterval: FAST_POLL_INTERVAL_MS, nextFetchPolicy: 'cache-and-network' })
  const dat = useData(data, ssrData)

  if (!dat) return <PageLoading />
  const w = dat.rewardsWalletInfo
  const health = dat.rewardsPoolHealth
  const dists = dat.rewardDistributions || []
  const budget = dat.curatorBudget
  const isDynamicBudget = budget?.mode === 'ACTIVE'
  const targetMultiple = budget?.targetMultBps == null ? '1.5×' : formatMultipleOrDash(budget.targetMultBps)
  const outstanding = OUTSTANDING_LABELS[w.outstandingRewards] ?? OUTSTANDING_LABELS.NONE

  return (
    <Layout footerLinks>
      <Row className='justify-content-center py-5'>
        <Col lg={8} xs={12}>
          <h2 className='text-center text-muted'>Rewards Wallet Transparency</h2>
          <p className='text-center text-muted pb-4'>
            The platform rewards wallet is StasherNews's only custodial component.
            Downvotes, posting fees, and territory fees land here and fund weekly
            curator payouts. Every payout is an on-chain transaction you can look up,
            and the public view key is published by design. The wallet's balance
            is not published: an advertised reserve is a target.
          </p>

          <div className='mb-4'>
            <WalletField label='Address' value={w.address} />
            <WalletField label='Public view key' value={w.viewKey} />
            <Stat label='Network' value={w.network} />
          </div>

          <h4 className='text-muted'>Pool health</h4>
          <p className='text-muted'>
            <small>
              The trend compares income with payouts over the last four weekly
              distributions: growing or draining when the average weekly change is
              more than 10% of average weekly payouts, stable otherwise. The runway
              is the reserve divided by the current weekly drain, shown as a range.
            </small>
          </p>
          <div className='d-flex flex-wrap justify-content-between border-bottom border-top py-3 my-2'>
            <Stat
              label='Status'
              value={<span className={`fw-bold ${poolStatusClass(health.status)}`}>{health.status ?? '—'}</span>}
              sub={health.status ? '4-week average' : 'after the second distribution'}
            />
            <Stat label='Runway' value={runwayLabel(health.runway) ?? '—'} sub='at the current 4-week rate' />
            <Stat label='Paid to curators' value={shareOrDash(health.curatorShareBps)} sub='of 4-week rewards income' />
            <Stat
              label='Rewards owed'
              value={<span className={outstanding.className}>{outstanding.text}</span>}
              sub='undelivered payouts vs. the ledger balance'
            />
          </div>
          {w.balanceNeedsReconciliation && (
            <div className='alert alert-warning mt-3 mb-0'>
              Wallet balance needs reconciliation
            </div>
          )}
          {w.opsUnderfunded && (
            <div className='alert alert-warning mt-3 mb-0'>
              Ops debt is unfunded: hot-wallet network fees and sweeps exceed the ops earmark
            </div>
          )}
          {w.accountingUncertain && (
            <div className='alert alert-warning mt-3 mb-0'>
              Rewards wallet accounting is uncertain: unresolved journal attempts or
              conflicting ledger facts. The figures on this page may be incomplete.
            </div>
          )}
          <small className='text-muted d-block mt-2'>
            {w.reconciliationEvidenceCurrent
              ? `Ledger facts match the latest published reconciliation check (${new Date(w.reconciliationCheckedAt).toLocaleString()}).`
              : w.reconciliationCheckedAt
                ? `The latest published reconciliation check (${new Date(w.reconciliationCheckedAt).toLocaleString()}) no longer matches the current ledger; it does not clear a known discrepancy.`
                : 'No full-wallet reconciliation check has been published yet.'}
          </small>

          <h4 className='text-muted mt-4'>How payouts are budgeted</h4>
          <p className='text-muted'>
            <small>
              {isDynamicBudget
                ? (
                  <>
                    Weekly curator payouts follow the dynamic budget: about {targetMultiple} recent
                    eligible curator tips; when the reserve runs low, spending is limited to the
                    pool's income plus 1/{copyDrawdownWeeks(budget)} of its reserve each week, so
                    payouts slide gradually toward income instead of stopping; referral payouts
                    may be additional, limited by the remaining pool.
                    All unused rewards roll over.
                  </>
                  )
                : (
                  <>
                    Weekly curator payouts are capped at {piconerosToXmr(CURATOR_FALLBACK_CAP_PICONEROS)};
                    referral payouts may be additional, limited by the remaining pool.
                    All unused rewards roll over.
                  </>
                  )}
              {' '}The platform's share is swept to the ops wallet after each distribution;
              network fees are paid by ops.
            </small>
          </p>

          <h4 className='text-muted mt-4'>Activity</h4>
          <div className='d-flex flex-wrap justify-content-between border-bottom border-top py-3 my-2'>
            <Stat label='Distributions' value={health.distributionCount} sub='completed weekly runs' />
            <Stat label='Payouts' value={health.payoutCount} sub={`${health.curatorCount} unique curator${health.curatorCount === 1 ? '' : 's'}, all-time`} />
            <Stat label='Median payout' value={xmrOrDash(health.medianPayoutPiconeros)} sub='last 4 weeks' />
            <Stat label='Payouts delivered' value={deliveredShare(health.deliveredPayoutBps)} sub='relayed on chain, of all attempted' />
          </div>

          <h4 className='text-muted mt-4'>Income mix (all-time)</h4>
          <p className='text-muted'>
            <small>
              Where every confirmed inflow since the wallet opened came from, as a share
              of the total, with the allocation percentage each source sends to rewards
              (the rest goes to ops). Overall {formatShare(w.inflowMix.rewardsShareBps)} of
              income has gone to rewards.
            </small>
          </p>
          <div className='border-bottom border-top py-3 my-2'>
            <InflowMix mix={w.inflowMix} />
          </div>

          <h4 className='text-muted mt-4'>Distribution log</h4>
          <p className='text-muted'>
            <small>
              Recent weekly curator distributions. Each payout is a real on-chain
              Monero transaction from the rewards wallet — verify any tx hash on
              the explorer. Curator handles are shown as nyms; sub-threshold
              shares and {isDynamicBudget ? 'unused dynamic budget' : 'funds above the weekly curator cap'} roll
              over (less any additional referral payouts). The ops sweep is made when
              the hot wallet has enough unlocked change; otherwise it is deferred to
              the next week.
            </small>
          </p>
          {dists.length === 0
            ? (
              <div className='border-bottom border-top py-3 my-2'>
                <Stat label='No distributions yet' value='—' sub='the first weekly run will appear here' />
              </div>
              )
            : (
              <div className='border-bottom border-top py-3 my-2'>
                {dists.map((d, di) => {
                  const stages = d.eligibleTipStages
                  const backfilled = stages?.backfilled === true
                  const makeup = d.makeupPiconeros == null ? 0n : toBigInt(d.makeupPiconeros)
                  return (
                    <div key={d.id} className={di < dists.length - 1 ? 'mb-4 pb-3 border-bottom' : ''}>
                      <div className='d-flex flex-wrap justify-content-between'>
                        <Stat
                          label={`Distribution #${d.id} — ${d.status}`}
                          value={`${d.payoutCount} payout${d.payoutCount === 1 ? '' : 's'}`}
                          sub={`${new Date(d.periodStart).toLocaleDateString()} → ${new Date(d.periodEnd).toLocaleDateString()}`}
                        />
                        <Stat label='Distributed' value={piconerosToXmr(toBigInt(d.distributedPiconeros))} />
                      </div>
                      {d.trustedTipPiconeros != null && (
                        <>
                          <div className='d-flex flex-wrap justify-content-between align-items-start ms-2 mt-1'>
                            <Stat label='Raw tips' value={xmrOrDash(d.rawTipPiconeros)} sub='before eligibility filters' />
                            <Stat
                              label='Eligible T (final)'
                              value={xmrOrDash(d.trustedTipPiconeros)}
                              sub={backfilled ? 'backfilled from recorded history' : 'after exclusions, caps and breaker'}
                            />
                            <Stat label='Tippers' value={d.tipperCount ?? '—'} />
                            <Stat label='T4' value={xmrOrDash(d.tipT4Piconeros)} sub='four-week average eligible tips' />
                            <Stat label='m' value={formatMultipleOrDash(d.multBps)} sub='this run' />
                            <Stat label='Dynamic budget' value={xmrOrDash(d.dynamicBudgetPiconeros)} />
                            <Stat label='Applied budget' value={xmrOrDash(d.appliedCuratorBudgetPiconeros)} sub={d.curatorBudgetMode ?? '—'} />
                            <Stat label='Mode' value={d.curatorBudgetMode ?? '—'} sub={d.dynamicBudgetMode ?? undefined} />
                          </div>
                          {(d.breakerTripped || makeup > 0n) && (
                            <div className='ms-2 mt-1'>
                              {d.breakerTripped && (
                                <small className='text-warning d-block'>
                                  breaker tripped (raw {xmrOrDash(d.breakerRawTPiconeros)}, capped {xmrOrDash(d.trustedTipPiconeros)})
                                </small>
                              )}
                              {makeup > 0n && (
                                <small className='text-muted d-block'>
                                  {d.curatorBudgetMode === 'ACTIVE'
                                    ? `make-up included in this run's dynamic target: +${piconerosToXmr(makeup)} (the target is bounded by the pool and paid shares; not a record of delivery)`
                                    : `hypothetical make-up not applied in ${d.curatorBudgetMode ?? 'LEGACY'} mode: +${piconerosToXmr(makeup)}`}
                                </small>
                              )}
                            </div>
                          )}
                          {stages && (
                            <details className='ms-2 mt-1'>
                              <summary><small className='text-muted'>Eligible-T stage breakdown</small></summary>
                              <div className='d-flex flex-wrap justify-content-between align-items-start mt-1'>
                                {DISTRIBUTION_STAGE_ROWS.map(([key, label]) => {
                                  const value = stageXmr(stages, key)
                                  return value == null ? null : <Stat key={key} label={label} value={value} />
                                })}
                              </div>
                              <small className='text-muted d-block'>
                                Totals only; no individual tipper identities are published.
                                {backfilled ? ' Backfilled from recorded history at release.' : ''}
                              </small>
                              {stages.staleTrustFallback === true && (
                                <small className='text-muted d-block'>Stale trust: the previous recorded T was reused.</small>
                              )}
                              {stages.breakerArmed === true && stages.breakerThreshold != null && (
                                <small className='text-muted d-block'>Breaker threshold {stageXmr(stages, 'breakerThreshold')}.</small>
                              )}
                            </details>
                          )}
                        </>
                      )}
                      <div className='ms-2 mt-1'>
                        <small className='text-muted d-block'>ops sweep: {opsSweepLabel(d.opsSweepState)}</small>
                        {d.opsSweepTxHash && d.opsSweepTxHash.split(',').map((h, i) => (
                          <a key={h} href={`${explorerTxUrl(w.network)}${h}`} target='_blank' rel='noreferrer' className='d-block'>
                            <small className='text-monospace text-break text-decoration-none'>
                              {i === 0 ? 'ops sweep' : 'sweep'} tx: {h.slice(0, 24)}…
                            </small>
                          </a>
                        ))}
                      </div>
                      {di === 0 && d.payouts.length > 0 && (
                        <div className='ms-2 mt-2'>
                          <small className='text-muted fw-bold d-block mb-1'>Payouts (latest distribution):</small>
                          {d.payouts.map(p => (
                            <div key={p.id} className='d-flex flex-column mb-1'>
                              <span className='text-monospace'>
                                {p.curatorNym || `user #${p.curatorId}`} — {p.amountXmr} XMR — {p.state}
                              </span>
                              {p.txHash && (
                                <a href={`${explorerTxUrl(w.network)}${p.txHash}`} target='_blank' rel='noreferrer'>
                                  <small className='text-monospace text-break text-decoration-none'>{p.txHash.slice(0, 24)}…</small>
                                </a>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              )}

          <div className='alert alert-light mt-4'>
            <h6>Verify independently</h6>
            <p className='mb-1'>
              The wallet address is public and every payout and sweep tx hash above
              can be looked up on the chain. The public view key above is embedded
              in that address and cannot decode incoming transaction amounts;
              transaction-level auditing would require the private view key, which
              the platform does not publish.
            </p>
            <p className='mb-0'>
              <a href={explorerFor(w.network)} target='_blank' rel='noreferrer'>
                Open the {w.network.toLowerCase()} explorer
              </a>
              <span className='text-muted'> · 1 XMR = 1,000,000,000,000 piconeros</span>
            </p>
          </div>
        </Col>
      </Row>
    </Layout>
  )
}
