import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { gql } from '@apollo/client'
import { useMutation } from '@apollo/client/react'
import { Alert, Button, Form } from 'react-bootstrap'
import { phraseError, phraseKeypair } from '@/lib/recoveryPhrase'
import { authErrorMessage } from './login'
import styles from './login.module.css'

const CREATE_AUTH = gql`mutation { createAuth { k1 } }`

export default function PhraseLoginForm ({ callbackUrl, multiAuth }) {
  const [phrase, setPhrase] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [createAuth] = useMutation(CREATE_AUTH)

  const submit = async (e) => {
    e.preventDefault()
    setError(null)
    const err = phraseError(phrase)
    if (err) {
      setError(err.index ? `word ${err.index} is not in the wordlist` : err.message)
      return
    }
    setBusy(true)
    try {
      // fresh challenge at submit time keeps the expiry window tiny
      const { data } = await createAuth()
      const { k1 } = data.createAuth
      const { pubkey, signChallenge } = phraseKeypair(phrase)
      const sig = signChallenge(k1)
      // redirect: false so pubkeyAuth's distinct no-account error (and every
      // other failure) renders right here instead of a dead-end redirect
      const res = await signIn('phrase', { k1, pubkey, sig, callbackUrl, multiAuth, redirect: false })
      if (res?.error) {
        setError(authErrorMessage(res.error, true))
        setBusy(false)
        return
      }
      // with redirect: false we own navigation on success too
      window.location.assign(res?.url ?? callbackUrl ?? '/')
    } catch (e2) {
      setError(e2?.message ?? 'something went wrong. try again.')
      setBusy(false)
    }
  }

  return (
    <Form onSubmit={submit} className='w-100'>
      {error && <Alert variant='danger' onClose={() => setError(null)} dismissible>{error}</Alert>}
      <Form.Group className='mb-3'>
        <Form.Label>12-word recovery phrase</Form.Label>
        <Form.Control
          as='textarea'
          rows={3}
          placeholder='paste your twelve words here'
          value={phrase}
          onChange={e => setPhrase(e.target.value)}
          autoComplete='off'
          autoFocus
        />
      </Form.Group>
      <Button className={`w-100 ${styles.providerButton}`} variant='outline-primary' type='submit' disabled={busy}>
        {busy ? 'Checking...' : 'Log in'}
      </Button>
    </Form>
  )
}
