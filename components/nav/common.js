import Link from 'next/link'
import { Button, Dropdown, Nav, Navbar } from 'react-bootstrap'
import styles from '../header.module.css'
import { useRouter } from 'next/router'
import BackArrow from '../../svgs/arrow-left-line.svg'
import { useCallback, useEffect, useState } from 'react'
import Price from '../price'
import SubSelect from '../sub-select'
import { LONG_POLL_INTERVAL_MS, PUBLIC_MEDIA_URL, SSR } from '../../lib/constants'
import NoteIcon from '../../svgs/notification-4-fill.svg'
import { useMe } from '../me'
import { abbrNum } from '../../lib/format'
import { DISPLAY_FONT } from '@/lib/rebrand'
import { COPY } from '@/lib/rebrand-copy'
import { useServiceWorker } from '../serviceworker'
import useCookie from '@/components/use-cookie'
import { cookieOptions, MULTI_AUTH_ANON, MULTI_AUTH_POINTER } from '@/lib/auth'
import Badges from '../badge'
import SearchIcon from '../../svgs/search-line.svg'
import classNames from 'classnames'
import { useHasNewNotes } from '../use-has-new-notes'
import { useWalletIndicator } from '@/wallets/client/hooks'
import SwitchAccountList, { useIsLurker } from '@/components/account'
import { useShowModal } from '@/components/modal'
import { ObstacleButtons } from '@/components/obstacle'
import { piconerosToXmr } from '@/lib/format'
import { useBranding } from '@/components/territory-branding'
import { gql } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { DaysHoursCountdown } from '@/components/countdown'

export function Brand ({ className, compact }) {
  const branding = useBranding()
  const logoUrl = branding?.logoId ? `${PUBLIC_MEDIA_URL}/${branding.logoId}` : null

  return (
    <Navbar.Brand as={Link} href='/' className={classNames(styles.brand, className)}>
      {logoUrl
        ? <img src={logoUrl} alt='site logo' width={36} height={36} className={styles.brandImage} loading='eager' decoding='async' />
        : compact
          ? <span className='brandMark'><span className='brandMarkS' style={{ fontFamily: DISPLAY_FONT }}>s</span><span className='brandMarkDot'>.</span></span>
          : <span className='brandWordmark' style={{ fontFamily: DISPLAY_FONT }}>stasher news<span className='brandDot'>.</span></span>}
    </Navbar.Brand>
  )
}

export function hasNavSelect ({ path, pathname }) {
  return (
    pathname.startsWith('/~') &&
    !path.endsWith('/post') &&
    !path.endsWith('/edit')
  )
}

export function Back () {
  const router = useRouter()
  const [back, setBack] = useState(router.asPath !== '/')

  useEffect(() => {
    setBack(router.asPath !== '/' && (typeof window.navigation === 'undefined' || window.navigation.canGoBack === undefined || window?.navigation.canGoBack))
  }, [router.asPath])

  if (!back) return null

  return (
    <a
      role='button' tabIndex='0' className='nav-link p-0 me-2' onClick={() => {
        if (back) {
          router.back()
        } else {
          router.push('/')
        }
      }}
    >
      <BackArrow className='theme me-1 me-md-2' width={24} height={24} />
    </a>
  )
}

export function BackOrBrand ({ className }) {
  const router = useRouter()
  const [back, setBack] = useState(router.asPath !== '/')

  useEffect(() => {
    setBack(router.asPath !== '/' && (typeof window.navigation === 'undefined' || window.navigation.canGoBack === undefined || window?.navigation.canGoBack))
  }, [router.asPath])

  return (
    <div className='d-flex align-items-center'>
      {back ? <Back /> : <Brand className={className} />}
    </div>
  )
}

export function SearchItem ({ prefix, className }) {
  return (
    <Nav.Link as={Link} href='/search' eventKey='search' className={className}>
      <SearchIcon className='theme' width={22} height={28} />
    </Nav.Link>
  )
}

export function NavPrice ({ className }) {
  return (
    <Nav.Item className={classNames(styles.price, className)}>
      <Price className='nav-link text-monospace' />
    </Nav.Item>
  )
}

const REWARDS = gql`
{
  rewards {
    total
    time
  }
}`

export function NavRewards () {
  const { data } = useQuery(REWARDS,
    SSR ? { ssr: false } : { pollInterval: LONG_POLL_INTERVAL_MS, nextFetchPolicy: 'cache-and-network' })
  const total = data?.rewards?.[0]?.total
  const time = data?.rewards?.[0]?.time
  if (!total) return null
  return (
    <Nav.Item className='navRewards d-none d-md-flex align-items-center gap-2'>
      <Link href='/rewards' className='nav-link p-0 navRewardsAmount'>
        {piconerosToXmr(BigInt(total))} in rewards
      </Link>
      {time &&
        <DaysHoursCountdown className='navRewardsTimer' date={time} />}
    </Nav.Item>
  )
}

const PREPEND_SUBS = ['home']
const APPEND_SUBS = [{ label: '--------', items: ['create'] }]
export function NavSelect ({ sub: subName, className, size }) {
  const sub = subName || 'home'

  return (
    <Nav.Item className={className}>
      <SubSelect
        sub={sub} prependSubs={PREPEND_SUBS} appendSubs={APPEND_SUBS} noForm
        groupClassName='mb-0' size={size}
      />
    </Nav.Item>
  )
}

export function NavNotifications ({ className }) {
  const hasNewNotes = useHasNewNotes()

  return (
    <>
      <Nav.Link as={Link} href='/notifications' eventKey='notifications' className={className}>
        <Indicator show={hasNewNotes} top='2px' right='0px' variant='danger'>
          <NoteIcon height={28} width={20} className='theme' />
        </Indicator>
      </Nav.Link>
    </>
  )
}

export function WalletSummary () {
  const { me } = useMe()
  if (!me || me.privates?.piconeros === 0) return null
  return (
    <span
      className='text-monospace'
      title={`${Number(me.privates?.piconeros).toLocaleString('en-US')} piconero (${piconerosToXmr(BigInt(me.privates?.piconeros))})`}
    >
      {`${abbrNum(me.privates?.piconeros)}`}
    </span>
  )
}

export function NavWalletSummary ({ className }) {
  const { me } = useMe()

  return (
    <Nav.Item className={className}>
      <Nav.Link as={Link} href='/statistics' eventKey='statistics' className='text-success text-monospace px-0 text-nowrap'>
        <WalletSummary me={me} />
      </Nav.Link>
    </Nav.Item>
  )
}

export const Indicator = ({ show, top = '0px', right = '0px', variant = 'secondary', children }) => {
  return (
    <div className='w-fit-content position-relative'>
      {children}
      {show && (
        <span
          className={`position-absolute p-1 bg-${variant}`}
          style={{ top, right, height: '5px', width: '5px', border: '1px solid var(--bs-body-bg)' }}
        >
          <span className='invisible'>{' '}</span>
        </span>
      )}
    </div>
  )
}

export function MeDropdown ({ me, dropNavKey }) {
  const walletIndicator = useWalletIndicator()
  if (!me) return null

  const profileIndicator = !me.bioId
  const indicator = profileIndicator || walletIndicator

  return (
    <div className='ms-2'>
      <Dropdown className={styles.dropdown} align='end'>
        <Dropdown.Toggle className='nav-link nav-item fw-normal' id='profile' variant='custom'>
          <div className='d-flex align-items-center'>
            <Nav.Link eventKey={me.name} as='span' className='p-0 navNym'>
              <Indicator show={indicator} top='2px' right='-5px'>@{me.name}</Indicator>
            </Nav.Link>
            <Badges user={me} className='ms-1' height={16} width={14} />
          </div>
        </Dropdown.Toggle>
        <Dropdown.Menu>
          <Dropdown.Item as={Link} href={'/' + me.name} active={me.name === dropNavKey}>
            <Indicator show={profileIndicator} top='2px' right='-10px'>profile</Indicator>
          </Dropdown.Item>
          <Dropdown.Item as={Link} href={'/' + me.name + '/bookmarks'} active={me.name + '/bookmarks' === dropNavKey}>bookmarks</Dropdown.Item>
          <Dropdown.Item as={Link} href='/settings/wallet' eventKey='wallets'>
            <Indicator show={walletIndicator} top='2px' right='-10px'>wallets</Indicator>
          </Dropdown.Item>
          <Dropdown.Item as={Link} href='/statistics' eventKey='statistics'>statistics</Dropdown.Item>
          <Dropdown.Divider />
          <Dropdown.Item as={Link} href='/referrals/day' eventKey='referrals'>referrals</Dropdown.Item>
          <Dropdown.Divider />
          <div className='d-flex align-items-center'>
            <Dropdown.Item as={Link} href='/settings' eventKey='settings'>settings</Dropdown.Item>
          </div>
          <Dropdown.Divider />
          <LogoutDropdownItem />
        </Dropdown.Menu>
      </Dropdown>
    </div>
  )
}

// this is the width of the 'switch account' button if no width is given
const SWITCH_ACCOUNT_BUTTON_WIDTH = '162px'

export function SignUpButton ({ className, width }) {
  const router = useRouter()
  const handleLogin = useCallback(async pathname => await router.push({
    pathname,
    query: { callbackUrl: window.location.origin + router.asPath }
  }), [router])

  return (
    <Button
      className={classNames('align-items-center py-0 px-3', className)}
      style={{ borderWidth: '2px', width: width || SWITCH_ACCOUNT_BUTTON_WIDTH }}
      id='signup'
      onClick={() => handleLogin('/signup')}
    >
      sign up
    </Button>
  )
}

export default function LoginButton ({ className, width }) {
  const router = useRouter()
  const handleLogin = useCallback(async pathname => await router.push({
    pathname,
    query: { callbackUrl: window.location.origin + router.asPath }
  }), [router])

  return (
    <Button
      className={classNames('align-items-center px-3 py-1', className)}
      id='login'
      style={{ borderWidth: '2px', width: width || SWITCH_ACCOUNT_BUTTON_WIDTH }}
      variant='outline-grey-darkmode'
      onClick={() => handleLogin('/login')}
    >
      login
    </Button>
  )
}

function LogoutObstacle ({ onClose }) {
  const { registration: swRegistration, togglePushSubscription } = useServiceWorker()
  const router = useRouter()
  const [, setPointerCookie] = useCookie(MULTI_AUTH_POINTER)

  const handleLogout = async () => {
    // order is important because we need to be logged in to delete push subscription on server
    const pushSubscription = await swRegistration?.pushManager.getSubscription()
    if (pushSubscription) {
      await togglePushSubscription().catch(console.error)
    }

    // switch to anon: we become unauthenticated but keep parked accounts
    // resumable via /login
    setPointerCookie(MULTI_AUTH_ANON, cookieOptions({ httpOnly: false }))
    onClose()
    // reload whatever page we're on to avoid any bugs
    router.reload()
  }

  return (
    <div className='text-center'>
      <h4 className='mb-3'>{COPY.logoutConfirm}</h4>
      <ObstacleButtons
        onClose={onClose}
        onConfirm={handleLogout}
        confirmText='logout'
        confirmVariant='primary'
      />
    </div>
  )
}

export function LogoutDropdownItem ({ handleClose }) {
  const showModal = useShowModal()

  return (
    <>
      <Dropdown.Item onClick={() => {
        handleClose?.()
        showModal(onClose => <SwitchAccountList onClose={onClose} />)
      }}
      >switch account
      </Dropdown.Item>
      <Dropdown.Item
        onClick={async () => {
          handleClose?.()
          showModal(onClose => <LogoutObstacle onClose={onClose} />)
        }}
      >logout
      </Dropdown.Item>
    </>
  )
}

export function LoginButtons () {
  return (
    <>
      <Dropdown.Item className='py-1'>
        <LoginButton />
      </Dropdown.Item>
      <Dropdown.Item className='py-1'>
        <SignUpButton className='py-1' />
      </Dropdown.Item>
    </>
  )
}

export function Sorts ({ prefix, className }) {
  return (
    <>
      <Nav.Item className={className}>
        <Nav.Link as={Link} href={prefix + '/'} eventKey='' className={`${styles.navLink} ${styles.navSort}`}>lit</Nav.Link>
      </Nav.Item>
      <Nav.Item className={className}>
        <Nav.Link as={Link} href={prefix + '/new'} eventKey='new' className={`${styles.navLink} ${styles.navSort}`}>new</Nav.Link>
      </Nav.Item>
      <Nav.Item className={className}>
        <Nav.Link as={Link} href={prefix + '/top/posts/day'} eventKey='top' className={`${styles.navLink} ${styles.navSort}`}>top</Nav.Link>
      </Nav.Item>
    </>
  )
}

export function PostItem ({ className, prefix }) {
  const branding = useBranding()
  const isLurker = useIsLurker()
  // when a custom primary color is set we let the button text follow --bs-btn-color
  // otherwise we use the default text-black
  const textOverride = branding?.primaryColor ? '' : 'text-black'
  return (
    <Link href={prefix + '/post'} className={`${className} btn btn-md btn-${isLurker ? 'grey' : 'primary'} ${textOverride} py-md-1`}>
      post
    </Link>
  )
}

export function RightCorner ({ dropNavKey, className = 'd-none d-md-flex' }) {
  const { me } = useMe()
  return (
    <>
      {me
        ? <MeCorner dropNavKey={dropNavKey} me={me} className={className} />
        : <LoggedOutCorner className={className} />}
    </>
  )
}

export function MeCorner ({ dropNavKey, me, className }) {
  return (
    <div className={className}>
      <NavNotifications />
      <MeDropdown me={me} dropNavKey={dropNavKey} />
      <NavWalletSummary className='d-inline-block ms-1' />
    </div>
  )
}

// logged-out corner: anon is the logged-out state, so we just show sign-up + login.
// parked accounts are surfaced on /login rather than as a switchable @anon account.
export function LoggedOutCorner ({ className }) {
  return (
    <div className={classNames(className, 'd-flex align-items-center')}>
      <SignUpButton className='py-1' width='auto' />
      <LoginButton className='ms-2' width='auto' />
    </div>
  )
}
