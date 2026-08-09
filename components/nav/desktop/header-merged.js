import { Container, Nav, Navbar } from 'react-bootstrap'
import { Back, Brand, NavPrice, NavSelect, PostItem, RightCorner, SearchItem, Sorts, hasNavSelect } from '../common'
import { CommentsNavigator, useCommentsNavigatorContext } from '@/components/use-comments-navigator'
import { useBlockHeight } from '@/components/block-height'
import { useBranding } from '../../territory-branding'
import styles from '../../header.module.css'

// Rebrand single-row desktop header: collapses top-bar.js + second-bar.js into
// one wrapping row. Every element of the two bars is present — back arrow,
// brand, turf selector, lit/new/top sorts, search, price ticker, comment
// navigator, block-height pill, post button, notifications / @user dropdown /
// wallet balance via RightCorner. The second-bar elements keep their
// hasNavSelect/branding gating so non-turf pages look exactly as before.
function BlockHeightPill () {
  const { height } = useBlockHeight()
  if (!height) return null
  return (
    <span
      className='nav-block-height'
      title='current Monero block height'
      style={{
        fontFamily: 'var(--bs-font-monospace)',
        fontSize: '0.75rem',
        color: 'var(--bs-primary)',
        border: '1px solid rgba(255,102,0,0.35)',
        background: 'rgba(255,102,0,0.08)',
        borderRadius: 6,
        padding: '3px 8px',
        whiteSpace: 'nowrap'
      }}
    >
      ◉ {Number(height).toLocaleString()}
    </span>
  )
}

export default function HeaderMerged (props) {
  const { prefix, sub, topNavKey, dropNavKey } = props
  const branding = useBranding()
  const { navigator, commentCount } = useCommentsNavigatorContext()
  const showSubNav = hasNavSelect(props)

  return (
    <div className='d-none d-md-block'>
      <Container as='header' className='px-0'>
        <Navbar className='navMerged'>
          <Nav
            className={`${styles.navbarNav} navMergedRow`}
            activeKey={topNavKey}
          >
            <Back />
            <Brand className='me-1' />
            {showSubNav && !branding && <NavSelect sub={sub} size='medium' className='me-1' />}
            {showSubNav && (
              <div className='d-flex'>
                <Sorts {...props} className='ms-1' />
              </div>
            )}
            <SearchItem prefix={prefix} className='me-0 ms-2 d-none d-md-flex' />
            <div className='ms-auto d-flex align-items-center gap-2'>
              <BlockHeightPill />
              <NavPrice className='me-0 mx-md-auto d-none d-md-flex' />
              <CommentsNavigator navigator={navigator} commentCount={commentCount} />
              {showSubNav && <PostItem className='d-none d-md-flex' prefix={prefix} />}
              <RightCorner dropNavKey={dropNavKey} className='d-none d-md-flex' />
            </div>
          </Nav>
        </Navbar>
      </Container>
    </div>
  )
}
