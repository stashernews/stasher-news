import { useRouter } from 'next/router'
import DesktopHeader from './desktop/header'
import HeaderMerged from './desktop/header-merged'
import MobileHeader from './mobile/header'
import StickyBar from './sticky-bar'
import { PriceCarouselProvider } from './price-carousel'
import { usePrefix, useNavKeys } from '../territory-domains'
import { useRebrand } from '@/lib/rebrand'

// Selects the desktop header renderer: the merged single-row header when the
// rebrand flag is on, the current two-bar header otherwise. Pure and exported
// so the flag choice is testable without a render harness.
export function desktopHeader (rebrand) {
  return rebrand ? HeaderMerged : DesktopHeader
}

export default function Navigation ({ sub, hideMobileNav = false }) {
  const router = useRouter()
  const path = router.asPath.split('?')[0]
  const prefix = usePrefix(sub)
  const { topNavKey, dropNavKey } = useNavKeys(path, sub)
  const props = {
    prefix,
    path,
    pathname: router.pathname,
    topNavKey,
    dropNavKey,
    sub
  }

  const rebrand = useRebrand()
  const Header = desktopHeader(rebrand)

  return (
    <PriceCarouselProvider>
      <Header {...props} />
      {!hideMobileNav && <MobileHeader {...props} />}
      <StickyBar {...props} hideMobileNav={hideMobileNav} />
    </PriceCarouselProvider>
  )
}
