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
      rewardsEarmarkPiconeros
      opsEarmarkPiconeros
      inflowBreakdown {
        downvotePiconeros
        postingFeePiconeros
        territoryFeePiconeros
        totalPiconeros
        rewardsPiconeros
        opsPiconeros
        downvoteRewardsPct
        postingFeeRewardsPct
        territoryFeeRewardsPct
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
            The platform rewards wallet is StealthNews's only custodial component.
            Downvotes, posting fees, and territory fees land here and fund weekly
            curator payouts. Audit it independently — the view key is public by design.
          </p>

          <div className='mb-4'>
            <WalletField label='Address' value={w.address} />
            <WalletField label='Public view key' value={w.viewKey} />
            <Stat label='Network' value={w.network} />
          </div>

          <h4 className='text-muted'>Live balance</h4>
          <div className='d-flex flex-wrap justify-content-between border-bottom border-top py-3 my-2'>
            <Stat label='Balance' value={`${w.balanceXmr} XMR`} sub={`${w.balancePiconeros} piconeros`} />
            <Stat label='Total received' value={`${w.totalReceivedPiconeros} piconeros`} />
            <Stat label='Total sent' value={`${w.totalSentPiconeros} piconeros`} />
          </div>

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
              shares roll over to the next period.
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
