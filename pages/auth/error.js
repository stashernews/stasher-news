import { StaticLayout } from '@/components/layout'
import styles from '@/styles/error.module.css'
import { DISPLAY_FONT } from '@/lib/rebrand'
import { useRouter } from 'next/router'
import Button from 'react-bootstrap/Button'

export function getServerSideProps ({ query }) {
  return {
    props: {
      error: query.error
    }
  }
}

export default function AuthError ({ error }) {
  const router = useRouter()

  if (error === 'AccessDenied') {
    return (
      <StaticLayout>
        <h1 className={[styles.status, styles.smaller].join(' ')} style={{ fontFamily: DISPLAY_FONT }}><span>ACCESS DENIED</span></h1>
      </StaticLayout>
    )
  } else if (error === 'Verification') {
    return (
      <StaticLayout>
        <h2 className='pt-4'>Incorrect magic code</h2>
        <Button
          className='align-items-center my-3'
          style={{ borderWidth: '2px' }}
          id='login'
          onClick={() => router.back()}
          size='lg'
        >
          try again
        </Button>
      </StaticLayout>
    )
  } else if (error === 'Configuration') {
    return (
      <StaticLayout>
        <h1 className={[styles.status, styles.smaller].join(' ')} style={{ fontFamily: DISPLAY_FONT }}><span>configuration error</span></h1>
      </StaticLayout>
    )
  }

  return (
    <StaticLayout>
      <h1 className={[styles.status, styles.smaller].join(' ')} style={{ fontFamily: DISPLAY_FONT }}><span>auth error</span></h1>
    </StaticLayout>
  )
}
