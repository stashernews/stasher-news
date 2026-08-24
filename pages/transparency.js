import { gql } from 'graphql-tag'
import { Col, Row } from 'react-bootstrap'
import { getGetServerSideProps } from '@/api/ssrApollo'
import Layout from '@/components/layout'
import CopyChip from '@/components/copy-chip'
import PageLoading from '@/components/page-loading'
import { useQuery } from '@apollo/client/react'
import { useData } from '@/components/use-data'
import { SSR, FAST_POLL_INTERVAL_MS } from '@/lib/constants'

const REWARDS_WALLET = gql`
  query rewardsWalletInfo {
    rewardsWalletInfo {
      address
      viewKey
      network
      totalReceivedPiconeros
      totalSentPiconeros
      balancePiconeros
      balanceXmr
      balanceNeedsReconciliation
      rewardsEarmarkPiconeros
      opsEarmarkPiconeros
      inflowBreakdown {
        downvotePiconeros
        postingFeePiconeros
        territoryFeePiconeros
        walletlessTipPiconeros
        totalPiconeros
        rewardsPiconeros
        opsPiconeros
        downvoteRewardsPct
        postingFeeRewardsPct
        territoryFeeRewardsPct
        walletlessTipRewardsPct
      }
    }
    rewardDistributions(limit: 10) {
      id
      periodStart
      periodEnd
      poolPiconeros
      distributedPiconeros
      rolledOverPiconeros
      payoutCount
      status
      completedAt
      opsInflowPiconeros
      opsAvailablePiconeros
      opsSweptPiconeros
      opsSweepTxHash
      opsSweepState
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

// Monero outputs take ~10 blocks to unlock, so a weekly sweep of the ops earmark
// is sometimes deferred (SKIPPED_LOCKED): the funds stay in the rewards wallet
// and roll into next period's opsAvailable. This makes that lag visible, not
// mysterious. `pendingPiconeros` = what didn't sweep this run.
function toBigInt (v) {
  return typeof v === 'bigint' ? v : BigInt(v)
}

function pendingOpsPiconeros (d) {
  return toBigInt(d.opsAvailablePiconeros) - toBigInt(d.opsSweptPiconeros)
}

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
  const pi = w.inflowBreakdown
  const dists = dat.rewardDistributions || []

  return (
    <Layout footerLinks>
      <Row className='justify-content-center py-5'>
        <Col lg={8} xs={12}>
          <h2 className='text-center text-muted'>Rewards Wallet Transparency</h2>
          <p className='text-center text-muted pb-4'>
            The platform rewards wallet is StasherNews's only custodial component.
            Downvotes, posting fees, and territory fees land here and fund weekly
            curator payouts. Audit it independently — the view key is public by design.
          </p>

          <div className='mb-4'>
            <WalletField label='Address' value={w.address} />
            <WalletField label='Public view key' value={w.viewKey} />
            <Stat label='Network' value={w.network} />
          </div>

          <h4 className='text-muted'>Live balance</h4>
          <p className='text-muted'>
            <small>
              Received, sent, and balance are ledger-derived from the platform's
              own records: confirmed observations in, recorded payouts and ops
              sweeps out. Cross-check on-chain with the view key below — the
              wallet's real on-chain history is independently verifiable.
            </small>
          </p>
          <div className='d-flex flex-wrap justify-content-between border-bottom border-top py-3 my-2'>
            <Stat label='Balance' value={`${w.balanceXmr} XMR`} sub={`${w.balancePiconeros} piconeros`} />
            <Stat label='Total received' value={`${w.totalReceivedPiconeros} piconeros`} sub='confirmed observations (ledger)' />
            <Stat label='Total sent' value={`${w.totalSentPiconeros} piconeros`} sub='recorded payouts + ops sweeps' />
          </div>
          {w.balanceNeedsReconciliation && (
            <div className='alert alert-warning mt-3 mb-0'>
              Wallet balance needs reconciliation
            </div>
          )}

          <h4 className='text-muted mt-4'>Earmark split</h4>
          <p className='text-muted'>
            <small>
              The wallet holds one consolidated balance. The split below partitions it
              by each inflow source's allocation %, scaled to the live balance — the two
              halves always sum to the whole.
            </small>
          </p>
          <div className='d-flex flex-wrap justify-content-between border-bottom border-top py-3 my-2'>
            <Stat label='Rewards earmark' value={`${w.rewardsEarmarkPiconeros} piconeros`} sub='funds curator payouts' />
            <Stat label='Ops earmark' value={`${w.opsEarmarkPiconeros} piconeros`} sub='platform operations' />
          </div>

          <h4 className='text-muted mt-4'>Confirmed inflow by source</h4>
          <div className='d-flex flex-wrap justify-content-between border-bottom border-top py-3 my-2'>
            <Stat label='Downvotes' value={`${pi.downvotePiconeros} piconeros`} sub={`${pi.downvoteRewardsPct}% to rewards`} />
            <Stat label='Posting fees' value={`${pi.postingFeePiconeros} piconeros`} sub={`${pi.postingFeeRewardsPct}% to rewards`} />
            <Stat label='Turf fees' value={`${pi.territoryFeePiconeros} piconeros`} sub={`${pi.territoryFeeRewardsPct}% to rewards`} />
            <Stat label='Wallet-less tips' value={`${pi.walletlessTipPiconeros} piconeros`} sub={`${pi.walletlessTipRewardsPct}% to rewards`} />
          </div>
          <div className='d-flex flex-wrap justify-content-between py-3 my-2'>
            <Stat label='Total inflow' value={`${pi.totalPiconeros} piconeros`} />
            <Stat label='Rewards share' value={`${pi.rewardsPiconeros} piconeros`} />
            <Stat label='Ops share' value={`${pi.opsPiconeros} piconeros`} />
          </div>

          <h4 className='text-muted mt-4'>Distribution log</h4>
          <p className='text-muted'>
            <small>
              Recent weekly curator distributions. Each payout is a real on-chain
              Monero transaction from the rewards wallet — verify any tx hash on
              the explorer. Curator handles are shown as nyms; sub-threshold
              shares roll over to the next period. The ops earmark is swept to the
              ops wallet when the hot wallet has enough unlocked change; when it
              doesn't (recent incoming outputs are still locked), the sweep is
              deferred and the amount rolls into next week's opsAvailable.
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
                {dists.map((d, di) => (
                  <div key={d.id} className={di < dists.length - 1 ? 'mb-4 pb-3 border-bottom' : ''}>
                    <div className='d-flex flex-wrap justify-content-between'>
                      <Stat
                        label={`Distribution #${d.id} — ${d.status}`}
                        value={`${d.payoutCount} payout${d.payoutCount === 1 ? '' : 's'}`}
                        sub={`${new Date(d.periodStart).toLocaleDateString()} → ${new Date(d.periodEnd).toLocaleDateString()}`}
                      />
                      <Stat label='Pool' value={`${d.poolPiconeros} pico`} />
                      <Stat label='Distributed' value={`${d.distributedPiconeros} pico`} />
                      <Stat label='Rolled over' value={`${d.rolledOverPiconeros} pico`} />
                    </div>
                    <div className='d-flex flex-wrap justify-content-between align-items-start ms-2 mt-1'>
                      <Stat label='Ops inflow' value={`${d.opsInflowPiconeros} pico`} sub="this period's ops share" />
                      <Stat label='Ops swept' value={`${d.opsSweptPiconeros} pico`} sub={`ops sweep: ${opsSweepLabel(d.opsSweepState)}`} />
                      <Stat
                        label='Pending ops (rolled over)'
                        value={`${pendingOpsPiconeros(d).toString()} pico`}
                        sub={d.opsSweepState === 'SKIPPED_LOCKED' ? 'deferred — locked change, lands next period' : 'to next period'}
                      />
                    </div>
                    {d.opsSweepTxHash && (
                      <div className='ms-2 mt-1'>
                        {d.opsSweepTxHash.split(',').map((h, i) => (
                          <a key={h} href={`${explorerTxUrl(w.network)}${h}`} target='_blank' rel='noreferrer' className='d-block'>
                            <small className='text-monospace text-break text-decoration-none'>
                              {i === 0 ? 'ops sweep' : 'sweep'} tx: {h.slice(0, 24)}…
                            </small>
                          </a>
                        ))}
                      </div>
                    )}
                    {di === 0 && d.payouts.length > 0 && (
                      <div className='ms-2 mt-2'>
                        <small className='text-muted fw-bold d-block mb-1'>Payouts (latest distribution):</small>
                        {d.payouts.map(p => (
                          <div key={p.id} className='d-flex flex-column mb-1'>
                            <span className='text-monospace'>
                              {p.curatorNym || `user #${p.curatorId}`} — {p.amountXmr} XMR
                              {' '}<span className='text-muted'>({p.piconeros} pico)</span> — {p.state}
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
                ))}
              </div>
              )}

          <div className='alert alert-light mt-4'>
            <h6>Verify independently</h6>
            <p className='mb-1'>
              Anyone can audit this wallet. Paste the address <em>and</em> the public
              view key above into any Monero block explorer to see every incoming
              transaction and the live balance.
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
