import { useEffect, useRef } from 'react'
import styles from '@/components/header.module.css'
import { Container, Nav, Navbar } from 'react-bootstrap'
import { Back, NavPrice, NavWalletSummary, SignUpButton } from './common'
import { useMe } from '@/components/me'
import classNames from 'classnames'
import { CommentsNavigator, useCommentsNavigatorContext } from '../use-comments-navigator'
import MergedNavRow from './desktop/merged-nav-row'

// Scroll sticky bar. The desktop section renders the same MergedNavRow as the
// merged top header (pixel-identical elements and layout, including the turf
// selector, sorts, post button and the centered rewards/price cluster). The
// mobile section keeps its intentional upstream behavior: back button on the
// sticky bar when scrolling down, even on custom domains where the top bar is
// hidden.
export default function StickyBar (props) {
  const { hideMobileNav = false } = props
  const ref = useRef()
  const { me } = useMe()
  const { navigator, commentCount } = useCommentsNavigatorContext()

  useEffect(() => {
    const stick = () => {
      if (window.scrollY > 100) {
        ref.current?.classList.remove(styles.hide)
      } else {
        ref.current?.classList.add(styles.hide)
      }
    }

    window.addEventListener('scroll', stick)

    return () => {
      window.removeEventListener('scroll', stick)
    }
  }, [ref?.current])

  return (
    <div className={classNames(styles.hide, styles.sticky)} ref={ref}>
      <Container fluid className='d-none d-md-block px-3'>
        <Navbar className='navMerged'>
          <MergedNavRow {...props} />
        </Navbar>
      </Container>
      {!hideMobileNav && (
        <Container className='px-sm-0 d-block d-md-none'>
          <Navbar className='py-0'>
            <Nav
              className={classNames(styles.navbarNav, 'navMobileRow')}
              activeKey={props.topNavKey}
            >
              <div className='navMobileLeft'>
                <Back />
              </div>
              <div className='navMobileCenter'>
                <NavPrice className='flex-shrink-1' />
              </div>
              <div className='navMobileRight'>
                <CommentsNavigator navigator={navigator} commentCount={commentCount} className='d-flex' />
                {me ? <NavWalletSummary className='px-2' /> : <SignUpButton width='fit-content' />}
              </div>
            </Nav>
          </Navbar>
        </Container>
      )}
    </div>
  )
}
