import { NextSeo } from 'next-seo'
import { useRouter } from 'next/router'
import removeMd from 'remove-markdown'
import { numWithUnits, piconerosToXmr } from '@/lib/format'
import { useBranding } from './territory-branding'

// Resolves the brand/site-name/tagline triple for SEO meta:
// - on a custom domain those come from the territory's branding (with sub-name fallbacks)
// - on stasher news those fall back to the SN defaults.
function useSiteSeo () {
  const branding = useBranding()

  const brand = branding?.title ?? 'stasher news'
  const siteName = branding?.title ?? 'Stasher News'
  const tagline = branding?.tagline ?? 'moderating forums with money'

  // territory branding doesn't carry a twitter handle, so suppress @site on custom domains
  const twitter = branding
    ? { cardType: 'summary_large_image' }
    : { site: 'stashernews', cardType: 'summary_large_image' }

  return { branding, brand, siteName, tagline, twitter }
}

// capture service takes a path and navigates to it on the main domain (stasher.news)
// to support custom domains, we need to prepend the subname to the path
function capturePath ({ path, branding }) {
  if (!branding?.subName) return path

  if (path === '/') return `/~${branding.subName}`
  return `/~${branding.subName}${path}`
}

export function SeoSearch ({ sub }) {
  const router = useRouter()
  const { branding, brand, siteName, twitter } = useSiteSeo()
  const imagePath = capturePath({ path: router.asPath, branding })

  const subStr = !branding && sub ? ` ~${sub}` : ''
  const query = router.query.q || ''
  const title = `${query || 'search'} \\ ${brand}${subStr}`
  const desc = branding
    ? `${brand} search: ${query}`
    : `SN${subStr} search: ${query}`

  return (
    <NextSeo
      title={title}
      description={desc}
      openGraph={{
        title,
        description: desc,
        images: [
          {
            url: 'https://capture.stasher.news' + imagePath
          }
        ],
        site_name: siteName
      }}
      twitter={twitter}
    />
  )
}

// for a sub we need
// item seo
// index page seo
// recent page seo

export default function Seo ({ sub, item, user }) {
  const router = useRouter()
  const pathNoQuery = router.asPath.split('?')[0]
  const { branding, brand, siteName, tagline, twitter } = useSiteSeo()
  const imagePath = capturePath({ path: pathNoQuery, branding })

  const defaultTitle = pathNoQuery.slice(1)
  const snStr = `${brand}${!branding && sub ? ` ~${sub}` : ''}`

  let fullTitle = `${defaultTitle && `${defaultTitle} \\ `}${brand}`
  let desc = tagline

  if (item) {
    if (item.title) {
      fullTitle = `${item.title} \\ ${snStr}`
    } else if (item.root) {
      fullTitle = `reply on: ${item.root.title} \\ ${snStr}`
    }
    // at least for now subs (ie the only one is jobs) will always have text
    if (item.text) {
      desc = removeMd(item.text)
      if (desc) {
        desc = desc.replace(/\s+/g, ' ')
      }
    } else {
      desc = `@${item.user.name} stashed ${piconerosToXmr(BigInt(item.piconeros))} ${item.url ? `posting ${item.url}` : 'with this discussion'}`
    }
    if (item.ncomments) {
      desc += ` [${numWithUnits(item.ncomments, { unitSingular: 'comment', unitPlural: 'comments' })}`
      if (item.boost) {
        desc += `, ${item.boost} boost`
      }
      desc += ']'
    } else if (item.boost) {
      desc += ` [${item.boost} boost]`
    }
  }
  if (user) {
    desc = `@${user.name} has [${user.optional.stacked ? `${user.optional.stacked} stashed,` : ''}${numWithUnits(user.nitems, { unitSingular: 'item', unitPlural: 'items' })}]`
  }

  return (
    <NextSeo
      title={fullTitle}
      description={desc}
      openGraph={{
        title: fullTitle,
        description: desc,
        images: [
          {
            url: 'https://capture.stasher.news' + imagePath
          }
        ],
        site_name: siteName
      }}
      twitter={twitter}
    />
  )
}
