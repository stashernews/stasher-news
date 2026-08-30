import { useState } from 'react'
import { useRouter } from 'next/router'
import { Button } from 'react-bootstrap'
import PhraseAuthWizard from './phrase-auth-wizard'

export default function PhraseLinkButton ({ status, fingerprint, unlink }) {
  const [showWizard, setShowWizard] = useState(false)
  const router = useRouter()

  return (
    <div className='mt-2 w-100'>
      <div className='d-flex align-items-center'>
        <span className='text-muted me-3'>
          {status ? `linked: recovery phrase ${fingerprint ?? ''}` : 'no recovery phrase linked'}
        </span>
        {status
          ? (
            <>
              <Button variant='secondary' onClick={async () => await unlink()}>Unlink phrase</Button>
              <Button variant='secondary' className='ms-2' onClick={() => setShowWizard(true)}>Replace phrase</Button>
            </>
            )
          : <Button variant='secondary' onClick={() => setShowWizard(true)}>Add recovery phrase</Button>}
      </div>
      {showWizard && (
        <div className='mt-2'>
          {status && (
            <p className='text-muted small mb-2'>
              Replacing writes a new phrase. The old one stops working immediately.
            </p>
          )}
          <PhraseAuthWizard
            mode='link'
            replace={status}
            onDone={async () => {
              setShowWizard(false)
              // SSR refetch picks up the new authMethods
              await router.replace(router.asPath)
            }}
          />
          <Button variant='link' className='p-0' onClick={() => setShowWizard(false)}>cancel</Button>
        </div>
      )}
    </div>
  )
}
