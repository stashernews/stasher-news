import { useEffect } from 'react'
import { StaticLayout } from '@/components/layout'
import PhraseAuthWizard from '@/components/phrase-auth-wizard'
import * as cookie from 'cookie'
import { cookieOptions } from '@/lib/auth'
import Login from '@/components/login'
export { getServerSideProps } from '../login'

export default function PhraseSignUp ({ providers, callbackUrl, ...props }) {
  const phraseEnabled = Object.values(providers || {}).some(p => p.id === 'phrase')

  // signup mode: clear the login (signin) cookie exactly like /signup does,
  // otherwise a stale cookie makes the provider refuse account creation
  useEffect(() => {
    document.cookie = cookie.serialize('signin', '', cookieOptions({ httpOnly: false, maxAge: 0 }))
  }, [])

  if (!phraseEnabled) {
    return (
      <StaticLayout footerLinks={false}>
        <Login providers={providers} callbackUrl={callbackUrl} {...props} />
      </StaticLayout>
    )
  }

  return (
    <StaticLayout footerLinks={false}>
      <PhraseAuthWizard mode='signup' callbackUrl={callbackUrl} />
    </StaticLayout>
  )
}
