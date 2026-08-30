import { useCallback, useMemo, useState } from 'react'
import { signIn } from 'next-auth/react'
import { gql } from '@apollo/client'
import { useMutation } from '@apollo/client/react'
import { Alert, Button, Form } from 'react-bootstrap'
import clipboardCopy from 'clipboard-copy'
import { generatePhrase, phraseKeypair } from '@/lib/recoveryPhrase'
import { COPY } from '@/lib/rebrand-copy'

const CREATE_AUTH = gql`mutation { createAuth { k1 } }`
const LINK_PHRASE = gql`
  mutation linkPhrase($k1: String!, $pubkey: String!, $sig: String!) {
    linkPhrase(k1: $k1, pubkey: $pubkey, sig: $sig) {
      phrase
      phraseFingerprint
    }
  }
`

function randomPositions () {
  const first = Math.floor(Math.random() * 12)
  let second = Math.floor(Math.random() * 11)
  if (second >= first) second += 1
  return [first + 1, second + 1].sort((a, b) => a - b)
}

export default function PhraseAuthWizard ({ mode, replace, callbackUrl, onDone }) {
  const [step, setStep] = useState('brief') // brief | show | prove | submitting
  const [phrase] = useState(() => generatePhrase())
  const [positions] = useState(randomPositions)
  const [answers, setAnswers] = useState({ [positions[0]]: '', [positions[1]]: '' })
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState(null)
  const [createAuth] = useMutation(CREATE_AUTH)
  const [linkPhrase] = useMutation(LINK_PHRASE)
  const words = useMemo(() => phrase.split(' '), [phrase])

  const submit = useCallback(async () => {
    setError(null)
    for (const p of positions) {
      if (answers[p]?.trim().toLowerCase() !== words[p - 1]) {
        setError(`word ${p} does not match. check your paper, not your memory.`)
        return
      }
    }
    if (!confirmed) return
    setStep('submitting')
    try {
      // fresh challenge at submit time keeps the expiry window tiny
      const { data } = await createAuth()
      const { k1 } = data.createAuth
      const { pubkey, signChallenge } = phraseKeypair(phrase)
      const sig = signChallenge(k1)
      if (mode === 'link') {
        await linkPhrase({ variables: { k1, pubkey, sig } })
        onDone?.()
      } else {
        await signIn('phrase', { k1, pubkey, sig, callbackUrl: callbackUrl || '/' })
      }
    } catch (e) {
      setError(e?.message ?? 'something went wrong. try again.')
      setStep('prove')
    }
  }, [answers, confirmed, createAuth, linkPhrase, mode, onDone, positions, phrase, words, callbackUrl])

  return (
    <div>
      {error && <Alert variant='danger' onClose={() => setError(null)} dismissible>{error}</Alert>}

      {step === 'brief' && (
        <>
          <h3 className='w-100 pb-2'>
            {mode === 'link' ? (replace ? COPY.phraseReplaceTitle : COPY.phraseAddTitle) : COPY.phraseSignupButton}
          </h3>
          <p className='fw-bold text-muted'>{mode === 'link' ? COPY.phraseLinkBriefing : COPY.phraseBriefing}</p>
          <p className='text-muted'>{COPY.phraseNotWallet}</p>
          <p className='text-muted small'>{COPY.phraseSecurityNote}</p>
          <Button variant='primary' className='w-100 mt-2' onClick={() => setStep('show')}>
            Generate my phrase
          </Button>
        </>
      )}

      {step === 'show' && (
        <>
          <h3 className='w-100 pb-2'>{COPY.phraseWizardTitle}</h3>
          <ol className='d-grid gap-2' style={{ gridTemplateColumns: 'repeat(2, 1fr)', paddingLeft: '1.5rem' }}>
            {words.map((w, i) => <li key={i} className='text-break font-monospace'>{w}</li>)}
          </ol>
          <div className='d-flex gap-2 mt-3'>
            <Button variant='secondary' onClick={() => clipboardCopy(phrase)}>Copy</Button>
            <Button
              variant='secondary' onClick={() => {
                const blob = new Blob([phrase], { type: 'text/plain' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = 'stasher-recovery-phrase.txt'
                a.click()
                URL.revokeObjectURL(url)
              }}
            >Download
            </Button>
            <Button variant='primary' className='ms-auto' onClick={() => setStep('prove')}>I wrote it down</Button>
          </div>
        </>
      )}

      {step === 'prove' && (
        <>
          <h3 className='w-100 pb-2'>{COPY.phraseConfirm}</h3>
          {positions.map(p => (
            <Form.Group key={p} className='mb-3'>
              <Form.Label>word #{p}</Form.Label>
              <Form.Control
                value={answers[p]}
                onChange={e => setAnswers({ ...answers, [p]: e.target.value })}
                autoComplete='off'
                autoFocus={p === positions[0]}
              />
            </Form.Group>
          ))}
          <Form.Check
            className='mb-3'
            label='I saved these words somewhere the void cannot reach'
            checked={confirmed}
            onChange={e => setConfirmed(e.target.checked)}
          />
          <div className='d-flex gap-2'>
            <Button variant='secondary' onClick={() => setStep('show')}>Back to words</Button>
            <Button variant='primary' className='ms-auto' disabled={!confirmed || step === 'submitting'} onClick={submit}>
              {mode === 'link' ? (replace ? 'Replace phrase' : 'Add phrase') : 'Create my account'}
            </Button>
          </div>
        </>
      )}

      {step === 'submitting' && <p className='text-muted'>working...</p>}
    </div>
  )
}
