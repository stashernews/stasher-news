import { useState } from 'react'
import { useRouter } from 'next/router'
import { CenterLayout } from '@/components/layout'
import { isGateEnabled, sanitizeNext } from '@/lib/invite-gate'

export async function getServerSideProps ({ query }) {
  const next = sanitizeNext(query.next)
  // gate off -> the gate page is inert; send everyone home
  if (!isGateEnabled()) {
    return { redirect: { destination: next, permanent: false } }
  }
  return { props: { next } }
}

export default function GatePage ({ next }) {
  const router = useRouter()
  const [code, setCode] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function submit (e) {
    e.preventDefault()
    if (submitting || !code) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/gate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, next })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || 'invalid invite code')
        setSubmitting(false)
        return
      }
      router.push(data.next || next || '/')
    } catch (err) {
      console.error(err)
      setError('something went wrong, try again')
      setSubmitting(false)
    }
  }

  return (
    <CenterLayout>
      <div className='stealth-login-wordmark w-100 text-start pb-2'>
        stasher news<span className='stealth-login-wordmark-dot'>.</span>
      </div>
      <h3 className='w-100 pb-2'>
        invite only
      </h3>
      <div className='fw-bold text-muted w-100 text-start pb-4 line-height-md'>
        enter your invite code to get in
      </div>
      <form onSubmit={submit} className='w-100'>
        <input
          className='form-control mb-3'
          type='password'
          autoComplete='one-time-code'
          autoFocus
          placeholder='invite code'
          value={code}
          onChange={e => setCode(e.target.value)}
          disabled={submitting}
        />
        {error && <div className='text-danger fw-bold pb-3'>{error}</div>}
        <button className='btn btn-primary w-100' type='submit' disabled={submitting || !code}>
          {submitting ? 'checking…' : 'enter'}
        </button>
      </form>
    </CenterLayout>
  )
}
