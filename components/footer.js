import Container from 'react-bootstrap/Container'
import OverlayTrigger from 'react-bootstrap/OverlayTrigger'
import Popover from 'react-bootstrap/Popover'
import styles from './footer.module.css'
import Github from '@/svgs/github-fill.svg'
import Link from 'next/link'
import Sun from '@/svgs/sun-fill.svg'
import Moon from '@/svgs/moon-fill.svg'
import No from '@/svgs/no.svg'
import Prism from '@/svgs/prism.svg'
import MoneroMark from '@/svgs/monero.svg'
import Live from '@/svgs/chat-unread-fill.svg'
import NoLive from '@/svgs/chat-off-fill.svg'
import List from '@/svgs/list-unordered.svg'
import ListOff from '@/svgs/list-unordered-off.svg'
import Rewards from './footer-rewards'
import useDarkMode from './dark-mode'
import ActionTooltip from './action-tooltip'
import { useAnimationEnabled } from '@/components/animation'
import { useLiveCommentsToggle } from './use-live-comments'
import useCompactView from './use-compact-view'
import { META_SUB } from '@/lib/constants'

const RssPopover = (
  <Popover>
    <Popover.Body style={{ fontWeight: 500, fontSize: '.9rem' }}>
      <div className='d-flex justify-content-center'>
        <a href='/rss' className='nav-link p-0 d-inline-flex'>
          home
        </a>
        <span className='mx-2 text-muted'> \ </span>
        <a href='/~bitcoin/rss' className='nav-link p-0 d-inline-flex'>
          bitcoin
        </a>
      </div>
      <div className='d-flex justify-content-center'>
        <a href='/~monero/rss' className='nav-link p-0 d-inline-flex'>
          monero
        </a>
        <span className='mx-2 text-muted'> \ </span>
        <a href={`/~${META_SUB}/rss`} className='nav-link p-0 d-inline-flex'>
          {META_SUB}
        </a>
        <span className='mx-2 text-muted'> \ </span>
        <a href='/~jobs/rss' className='nav-link p-0 d-inline-flex'>
          jobs
        </a>
      </div>
    </Popover.Body>
  </Popover>
)

const SocialsPopover = (
  <Popover>
    <Popover.Body style={{ fontWeight: 500, fontSize: '.9rem' }}>
      <div className='d-flex justify-content-center'>
        <a href='https://x.com/stashernews' className='nav-link p-0 d-inline-flex' target='_blank' rel='noreferrer'>
          x
        </a>
      </div>
    </Popover.Body>
  </Popover>
)

const LegalPopover = (
  <Popover>
    <Popover.Body style={{ fontWeight: 500, fontSize: '.9rem' }}>
      <div className='d-flex justify-content-center'>
        <Link href='/tos' className='nav-link p-0 d-inline-flex'>
          terms of service
        </Link>
        <span className='mx-2 text-muted'> \ </span>
        <Link href='/privacy' className='nav-link p-0 d-inline-flex'>
          privacy policy
        </Link>
      </div>
      <div className='d-flex justify-content-center'>
        <Link href='/copyright' className='nav-link p-0 d-inline-flex'>
          copyright policy
        </Link>
      </div>
    </Popover.Body>
  </Popover>
)

// Shared footer preference toggle: a real button carrying switch semantics so
// the four preference toggles (dark mode, glitch, live comments, compact view)
// are keyboard-operable and exposed to assistive tech. The button stays mounted
// while the icon inside swaps, so keyboard focus survives each toggle.
function ToggleAction ({ on, label, Icon, onClick, className = '' }) {
  const text = `${on ? 'disable' : 'enable'} ${label}`
  return (
    <ActionTooltip notForm overlayText={text}>
      <button
        type='button' role='switch' aria-checked={on} aria-label={text}
        onClick={onClick}
        className={`d-inline-flex align-items-center align-middle bg-transparent border-0 p-0 ${className}`}
      >
        <Icon width={20} height={20} className='fill-grey theme' suppressHydrationWarning />
      </button>
    </ActionTooltip>
  )
}

export default function Footer ({ links = true }) {
  const [darkMode, darkModeToggle] = useDarkMode()

  const [animationEnabled, toggleAnimation] = useAnimationEnabled()

  const [disableLiveComments, toggleLiveComments] = useLiveCommentsToggle()

  const [compactView, toggleCompactView] = useCompactView()

  const DarkModeIcon = darkMode ? Sun : Moon
  const GlitchIcon = animationEnabled ? No : Prism
  const LiveIcon = disableLiveComments ? Live : NoLive
  const CompactIcon = compactView ? ListOff : List

  const version = process.env.NEXT_PUBLIC_COMMIT_HASH

  return (
    <footer>
      <Container className='mb-3'>
        {links &&
          <>
            <div className='mb-1'>
              <ToggleAction on={darkMode} label='dark mode' Icon={DarkModeIcon} onClick={darkModeToggle} />
              <ToggleAction on={animationEnabled} label='glitch animations' Icon={GlitchIcon} onClick={toggleAnimation} className='ms-2' />
              <ToggleAction on={!disableLiveComments} label='live comments' Icon={LiveIcon} onClick={toggleLiveComments} className='ms-2' />
              <ToggleAction on={compactView} label='compact view' Icon={CompactIcon} onClick={toggleCompactView} className='ms-2' />
            </div>
            <div className='mb-0' style={{ fontWeight: 500 }}>
              <Rewards />
            </div>
            <div className='mb-0' style={{ fontWeight: 500 }}>
              <Link href='/stashers/all/day' className='nav-link p-0 p-0 d-inline-flex'>
                analytics
              </Link>
              <span className='mx-2 text-muted'> \ </span>
              <OverlayTrigger trigger='click' placement='top' overlay={SocialsPopover} rootClose>
                <div className='nav-link p-0 p-0 d-inline-flex' style={{ cursor: 'pointer' }}>
                  socials
                </div>
              </OverlayTrigger>
              <span className='mx-2 text-muted'> \ </span>
              <OverlayTrigger trigger='click' placement='top' overlay={RssPopover} rootClose>
                <div className='nav-link p-0 p-0 d-inline-flex' style={{ cursor: 'pointer' }}>
                  rss
                </div>
              </OverlayTrigger>
            </div>
            <div className='mb-2' style={{ fontWeight: 500 }}>
              <Link href='/faq' className='nav-link p-0 p-0 d-inline-flex'>
                faq
              </Link>
              <span className='mx-2 text-muted'> \ </span>
              <Link href='/guide' className='nav-link p-0 p-0 d-inline-flex'>
                guide
              </Link>
              <span className='mx-2 text-muted'> \ </span>
              <OverlayTrigger trigger='click' placement='top' overlay={LegalPopover} rootClose>
                <div className='nav-link p-0 p-0 d-inline-flex' style={{ cursor: 'pointer' }}>
                  legal
                </div>
              </OverlayTrigger>
              <span className='mx-2 text-muted'> \ </span>
              <a className='nav-link p-0 d-inline-flex align-items-center' href='https://getmonero.org' target='_blank' rel='noreferrer' style={{ color: 'var(--bs-primary)', fontWeight: 600 }}>
                <MoneroMark width={16} height={16} className='me-1' />
                Powered by Monero
              </a>
            </div>
          </>}
        <small className='d-flex justify-content-center align-items-center text-muted flex-wrap'>
          <a className={`${styles.contrastLink} d-flex align-items-center`} href='https://github.com/stashernews/stasher-news' target='_blank' rel='noreferrer'>
            source <Github width={20} height={20} className='mx-1' />
          </a>
        </small>
        {version &&
          <div className={styles.version}>
            running <a className='text-reset' href={`https://github.com/stashernews/stasher-news/commit/${version}`} target='_blank' rel='noreferrer'>{version}</a>
          </div>}
      </Container>
    </footer>
  )
}
