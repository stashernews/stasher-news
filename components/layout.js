import Navigation from './nav'
import NavFooter from './nav/mobile/footer'
import NavStatic from './nav/static'
import Container from 'react-bootstrap/Container'
import Footer from './footer'
import Seo, { SeoSearch } from './seo'
import Search from './search'
import styles from './layout.module.css'
import PullToRefresh from './pull-to-refresh'
import WalletWarning from './wallet-warning'
import AnnouncementBanner from './announcement-banner'

export default function Layout ({
  sub, contain = true, footer = true, footerLinks = true,
  containClassName = '', seo = true, item, user, hideMobileNav = false, children
}) {
  return (
    <>
      {seo && <Seo sub={sub} item={item} user={user} />}
      <Navigation sub={sub} hideMobileNav={hideMobileNav} />
      <WalletWarning />
      {contain
        ? (
          <Container as={PullToRefresh} className={`px-sm-0 ${styles.contain} ${containClassName}`}>
            <AnnouncementBanner />
            {children}
          </Container>
          )
        : <><AnnouncementBanner />{children}</>}
      {footer && <Footer links={footerLinks} />}
      {!hideMobileNav && <NavFooter sub={sub} />}
    </>
  )
}

export function SearchLayout ({ sub, children, ...props }) {
  return (
    <Layout sub={sub} seo={false} footer={false} {...props}>
      <SeoSearch sub={sub} />
      <Search sub={sub} />
      {children}
    </Layout>
  )
}

export function StaticLayout ({ children, footer = true, footerLinks = false, ...props }) {
  return (
    <>
      <NavStatic />
      <div className={styles.page}>
        <main className={`${styles.content} ${styles.contain} py-3`}>
          {children}
        </main>
      </div>
      {footer && <Footer links={footerLinks} />}
      <NavFooter />
    </>
  )
}

// anchorTop: start content at the top instead of centering it vertically, for
// pages whose height changes in place (the /post type switcher)
export function CenterLayout ({ children, anchorTop, ...props }) {
  return (
    <Layout contain={false} footer={false} {...props}>
      <div className={`${styles.page} ${anchorTop ? styles.pageTop : ''}`}>
        <main className={`${styles.content} ${anchorTop ? styles.contentTop : ''}`}>
          {children}
        </main>
      </div>
    </Layout>
  )
}
