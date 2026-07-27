import Card from 'react-bootstrap/Card'
import Col from 'react-bootstrap/Col'
import Row from 'react-bootstrap/Row'
import Badge from 'react-bootstrap/Badge'
import Alert from 'react-bootstrap/Alert'
import Button from 'react-bootstrap/Button'
import { Form, Input, SubmitButton, CopyButton } from '@/components/form'
import { gql } from '@apollo/client'
import { useMutation, useQuery } from '@apollo/client/react'
import { useToast } from '@/components/toast'
import { useFormikContext } from 'formik'
import Qr from '@/components/qr'
import { useState } from 'react'

// StealthNews author wallet onboarding (spec §8.2).
//
// Three-step AUTO_INDEX wizard that consumes Task 8's registerMoneroAccount
// mutation. MANUAL_PROOF is rendered as a selectable card but disabled
// ("future phase") because its submitTipProof backend is Phase 5 and
// registerMoneroAccount requires a non-null view key.
//
// Client-side validation is best-effort only: dep-free heuristics (Base58 +
// length for addresses, 64-char hex for the view key) flag obvious garbage
// immediately. Authoritative validation lives on the server (Task 8 uses
// monero-ts MoneroUtils.isValidAddress / isValidPrivateViewKey) — GQL errors
// are surfaced via the Form toast. monero-ts is NOT imported client-side:
// it is WASM/Node-heavy and bundling it into the client would risk the
// Next.js build for negligible UX gain (the server validates identically).
//
// Subaddress pool: the UI cannot generate subaddresses (that needs the user's
// private spend key, which lives in their wallet), so the user PASTES a list
// from their wallet. We parse non-empty lines into { majorIndex, minorIndex,
// address }, assigning minorIndex = startMinor + lineIndex and a single
// majorIndex the user picks (default 0). This matches lws's conventional
// account-0, subaddress-N pool shape.

const MY_MONERO_ACCOUNT = gql`
  query MyMoneroAccount {
    myMoneroAccount {
      id
      address
      label
      privacyMode
      subaddressPoolRemaining
    }
  }
`

const REGISTER_MONERO_ACCOUNT_MUTATION = gql`
  mutation RegisterMoneroAccount(
    $address: String!
    $viewKey: String!
    $privacyMode: PrivacyMode!
    $subaddresses: [SubaddressInput!]
  ) {
    registerMoneroAccount(
      address: $address
      viewKey: $viewKey
      privacyMode: $privacyMode
      subaddresses: $subaddresses
    ) {
      id
      address
      label
      privacyMode
      subaddressPoolRemaining
    }
  }
`

// Default subaddress pool size per spec §8.2 ("default 50").
const DEFAULT_POOL_SIZE = 50

function networkName () {
  return (process.env.NEXT_PUBLIC_MONERO_NETWORK || 'stagenet').toLowerCase()
}

// Dep-free client heuristics for immediate feedback. These only catch
// obviously-wrong input; the server (Task 8, monero-ts) is authoritative.
// Monero addresses are Base58, 95 chars (standard) or 106 (integrated);
// private view keys are 64-char hex. Encoding network-specific address
// prefixes here would risk false negatives, so we keep it shape-only.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/

function heuristicCheckAddress (address) {
  if (!address) return 'required'
  if (address.length < 90 || address.length > 110) return 'address looks truncated or malformed'
  if (!BASE58.test(address)) return 'address contains invalid characters'
  return null
}

function heuristicCheckViewKey (viewKey) {
  if (!viewKey) return 'required'
  if (!/^[0-9a-fA-F]{64}$/.test(viewKey)) return 'view key must be 64 hex characters'
  return null
}

// Parse a pasted block of subaddresses (one per line) into the explicit-index
// pool shape Task 8 consumes. minorIndex is assigned sequentially from
// startMinor; majorIndex is the single account the user picks. Whitespace /
// blank lines are dropped.
function parseSubaddresses (paste, majorIndex, startMinor) {
  if (!paste) return []
  const lines = paste.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const major = Number.isFinite(Number(majorIndex)) ? Number(majorIndex) : 0
  const start = Number.isFinite(Number(startMinor)) ? Number(startMinor) : 0
  return lines.map((address, i) => ({
    majorIndex: major,
    minorIndex: start + i,
    address
  }))
}

export default function WalletSetup () {
  const { data, loading, error } = useQuery(MY_MONERO_ACCOUNT)
  if (loading) return <div className='text-muted'>loading wallet…</div>
  if (error) {
    return (
      <Alert variant='danger'>
        failed to load wallet status: {error.message}
      </Alert>
    )
  }
  const account = data?.myMoneroAccount
  if (account) return <ExistingAccount account={account} />
  return <WalletWizard />
}

function ExistingAccount ({ account }) {
  return (
    <Card>
      <Card.Body>
        <div className='d-flex align-items-center mb-2'>
          <h4 className='mb-0'>wallet registered</h4>
          <Badge bg='info' className='ms-2 text-uppercase'>
            {(account.privacyMode || '').toLowerCase().replace('_', ' ')}
          </Badge>
        </div>
        <p className='text-muted'>
          your wallet is under indexer observation. tips sent to any of your
          registered subaddresses are detected automatically and credited to
          your posts. tips are 100% peer-to-peer — stealthnews never holds
          your funds.
        </p>
        <Input
          label='primary address'
          name='addressDisplay'
          placeholder={account.address}
          readOnly
          noForm
          groupClassName='mb-3'
          append={<CopyButton value={account.address} icon />}
        />
        <div className='text-muted'>
          subaddress pool: <strong>{account.subaddressPoolRemaining}</strong> available
          {account.subaddressPoolRemaining < 10 && (
            <span className='text-warning ms-2'>
              (low — generate more in your wallet)
            </span>
          )}
        </div>
      </Card.Body>
    </Card>
  )
}

function WalletWizard () {
  const [step, setStep] = useState('address')
  const [address, setAddress] = useState('')

  if (step === 'address') {
    return (
      <>
        <WalletGuideCard />
        <AddressForm
          onDone={(addr) => {
            setAddress(addr)
            setStep('privacy')
          }}
        />
      </>
    )
  }

  if (step === 'privacy') {
    return (
      <PrivacyStep
        address={address}
        onPick={(mode) => {
          if (mode === 'AUTO_INDEX') setStep('auto_index')
        }}
        onBack={() => setStep('address')}
      />
    )
  }

  if (step === 'auto_index') {
    return (
      <AutoIndexForm
        address={address}
        onBack={() => setStep('privacy')}
      />
    )
  }

  return null
}

function WalletGuideCard () {
  return (
    <Card className='mb-3'>
      <Card.Body>
        <h5 className='mb-1'>need a monero wallet?</h5>
        <p className='text-muted small mb-2'>
          tips are 100% peer-to-peer — they go straight to your wallet. any of
          these work. use <strong>{networkName()}</strong> for this site.
        </p>
        <div className='d-flex gap-2 flex-wrap'>
          <Button
            variant='outline-info' size='sm' href='https://cakewallet.com'
            target='_blank' rel='noopener noreferrer'
          >cake wallet
          </Button>
          <Button
            variant='outline-info' size='sm' href='https://monerujo.io'
            target='_blank' rel='noopener noreferrer'
          >monerujo
          </Button>
          <Button
            variant='outline-info' size='sm' href='https://featherwallet.org'
            target='_blank' rel='noopener noreferrer'
          >feather wallet
          </Button>
        </div>
      </Card.Body>
    </Card>
  )
}

function AddressForm ({ onDone }) {
  return (
    <Card className='mb-3'>
      <Card.Body>
        <h5 className='mb-2'>step 1 — paste your primary address</h5>
        <Form
          initial={{ address: '' }}
          validate={({ address }) => {
            const errors = {}
            if (!address || !address.trim()) errors.address = 'required'
            return errors
          }}
          onSubmit={async ({ address }) => {
            const addr = address.trim()
            const err = heuristicCheckAddress(addr)
            if (err) throw new Error(err)
            onDone(addr)
          }}
        >
          <Input
            label={`primary monero address (${networkName()})`}
            name='address'
            placeholder='paste your wallet primary address'
            required
            autoFocus
            groupClassName='mb-3'
            hint={
              <small className='text-muted'>
                your wallet&apos;s main address — find it in cake / monerujo / feather.
              </small>
            }
          />
          <SubmitButton variant='info' className='px-4'>continue</SubmitButton>
        </Form>
      </Card.Body>
    </Card>
  )
}

function PrivacyStep ({ address, onPick, onBack }) {
  return (
    <>
      <div className='d-flex justify-content-between align-items-center mb-3'>
        <h5 className='mb-0'>step 2 — choose how tips are detected</h5>
        <Button variant='link' onClick={onBack} className='p-0'>back</Button>
      </div>
      <AddressConfirmBlock address={address} />
      <Row className='g-3 mt-0'>
        <Col md={6}>
          <Card
            className='h-100' border='info' style={{ cursor: 'pointer' }}
            onClick={() => onPick('AUTO_INDEX')}
          >
            <Card.Body>
              <h6 className='d-flex align-items-center mb-1'>
                automatic indexing
                <Badge bg='info' className='ms-2'>recommended</Badge>
              </h6>
              <small className='text-muted'>
                paste your view key plus a subaddress pool. the indexer watches
                the chain for you and credits tips automatically. your view key
                is encrypted at rest; it only lets us see incoming transfers —
                it cannot spend funds.
              </small>
              <div className='mt-2'>
                <Button variant='info' size='sm'>choose</Button>
              </div>
            </Card.Body>
          </Card>
        </Col>
        <Col md={6}>
          <Card className='h-100' style={{ opacity: 0.75 }}>
            <Card.Body>
              <h6 className='d-flex align-items-center mb-1'>
                manual proof
                <Badge bg='secondary' className='ms-2'>future phase</Badge>
              </h6>
              <small className='text-muted'>
                no view key — you paste a transaction proof for each tip you
                receive. this mode is planned for a later phase and is not
                available yet.
              </small>
              <div className='mt-2'>
                <Button variant='outline-secondary' size='sm' disabled>
                  not yet available
                </Button>
              </div>
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </>
  )
}

function AutoIndexForm ({ address, onBack }) {
  const toaster = useToast()
  const [register, { loading }] = useMutation(REGISTER_MONERO_ACCOUNT_MUTATION, {
    // Write the new account into the MY_MONERO_ACCOUNT cache so the parent
    // WalletSetup re-renders straight into the ExistingAccount state without
    // an extra round trip.
    update (cache, { data: { registerMoneroAccount } }) {
      cache.writeQuery({
        query: MY_MONERO_ACCOUNT,
        data: { myMoneroAccount: registerMoneroAccount }
      })
    }
  })

  return (
    <Card className='mb-3'>
      <Card.Body>
        <div className='d-flex justify-content-between align-items-center mb-2'>
          <h5 className='mb-0'>step 3 — view key + subaddress pool</h5>
          <Button variant='link' onClick={onBack} className='p-0'>back</Button>
        </div>
        <AddressConfirmBlock address={address} />
        <Form
          initial={{ viewKey: '', subaddressesPaste: '', majorIndex: 0, startMinor: 0 }}
          validate={({ viewKey, subaddressesPaste }) => {
            const errors = {}
            if (!viewKey || !viewKey.trim()) errors.viewKey = 'required'
            const parsed = parseSubaddresses(subaddressesPaste, 0, 0)
            if (parsed.length === 0) errors.subaddressesPaste = 'paste at least one subaddress'
            return errors
          }}
          onSubmit={async ({ viewKey, subaddressesPaste, majorIndex, startMinor }) => {
            const subaddresses = parseSubaddresses(
              subaddressesPaste, Number(majorIndex), Number(startMinor))
            const vk = viewKey.trim()
            const vkErr = heuristicCheckViewKey(vk)
            if (vkErr) throw new Error(vkErr)
            try {
              await register({
                variables: {
                  address,
                  viewKey: vk,
                  privacyMode: 'AUTO_INDEX',
                  subaddresses
                }
              })
              toaster.success('wallet registered with indexer')
            } catch (err) {
              // Surface the server's GQL error (Task 8 validates via monero-ts).
              throw new Error(err.message)
            }
          }}
        >
          <Input
            label='private view key'
            name='viewKey'
            type='password'
            placeholder='paste your wallet view key'
            required
            groupClassName='mb-3'
            hint={
              <small className='text-muted'>
                only lets us see incoming transfers — it cannot spend funds.
              </small>
            }
          />
          <Row>
            <Col xs={6}>
              <Input
                label='major index'
                name='majorIndex'
                type='number'
                min={0}
                groupClassName='mb-3'
                hint={
                  <small className='text-muted'>subaddress account (usually 0)</small>
                }
              />
            </Col>
            <Col xs={6}>
              <Input
                label='starting minor index'
                name='startMinor'
                type='number'
                min={0}
                groupClassName='mb-3'
                hint={
                  <small className='text-muted'>
                    first subaddress index in your paste (usually 0)
                  </small>
                }
              />
            </Col>
          </Row>
          <Input
            label='subaddress pool (one per line)'
            name='subaddressesPaste'
            as='textarea'
            rows={6}
            placeholder={`paste your subaddresses, one per line\n(about ${DEFAULT_POOL_SIZE} from your wallet)`}
            required
            groupClassName='mb-1'
            hint={<SubaddressPoolHint />}
          />
          <div className='text-muted small mb-3'>
            the ui cannot generate subaddresses — that needs your wallet&apos;s
            private spend key. generate them in your wallet, then paste here.
          </div>
          <div className='d-flex align-items-center'>
            <SubmitButton
              variant='info' className='px-4' disabled={loading}
              submittingText='Registering with indexer…'
            >register
            </SubmitButton>
          </div>
        </Form>
      </Card.Body>
    </Card>
  )
}

// Live "N subaddresses parsed" hint, read from formik context so it updates as
// the user pastes. Falls back to a static hint if formik context is missing.
function SubaddressPoolHint () {
  const formik = useFormikContext()
  const paste = formik?.values?.subaddressesPaste ?? ''
  const major = Number(formik?.values?.majorIndex ?? 0)
  const start = Number(formik?.values?.startMinor ?? 0)
  const count = parseSubaddresses(paste, major, start).length
  if (count === 0) {
    return (
      <small className='text-muted'>
        one subaddress per line — the pool the indexer will watch.
      </small>
    )
  }
  return (
    <small className='text-muted'>
      {count} subaddress{count === 1 ? '' : 's'} parsed
      {count < DEFAULT_POOL_SIZE && ` (spec recommends ~${DEFAULT_POOL_SIZE})`}.
    </small>
  )
}

// Address confirmation block with copy helper + QR. Rendered on the privacy
// and auto_index steps so the user can verify/scan the address they pasted
// before handing over their view key.
function AddressConfirmBlock ({ address }) {
  return (
    <Card className='mb-3' border='light'>
      <Card.Body className='d-flex flex-column flex-md-row align-items-center gap-3'>
        <div style={{ minWidth: 200 }}>
          <div className='text-muted small mb-1'>your receiving address</div>
          <div className='d-flex align-items-center'>
            <code className='text-break' style={{ fontSize: '0.8rem' }}>
              {address.slice(0, 12)}…{address.slice(-8)}
            </code>
            <CopyButton value={address} icon />
          </div>
        </div>
        <div style={{ maxWidth: 180 }}>
          <Qr
            value={address} copy={false}
            description={<span className='small'>scan to verify address</span>}
          />
        </div>
      </Card.Body>
    </Card>
  )
}
