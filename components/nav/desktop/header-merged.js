import { Container, Navbar } from 'react-bootstrap'
import MergedNavRow from './merged-nav-row'

// Rebrand single-row desktop header: renders the shared MergedNavRow (also
// used by the scroll sticky bar) so the top header and the sticky bar are
// pixel-identical. Every element of the original two bars is present — back
// arrow, brand, turf selector, lit/new/top sorts, search, price ticker pill,
// comment navigator, post button, notifications / @user dropdown / wallet
// balance via RightCorner.
export default function HeaderMerged (props) {
  return (
    <div className='d-none d-md-block'>
      <Container fluid as='header' className='px-3'>
        <Navbar className='navMerged'>
          <MergedNavRow {...props} />
        </Navbar>
      </Container>
    </div>
  )
}
