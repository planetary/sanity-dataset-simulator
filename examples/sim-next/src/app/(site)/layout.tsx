import Link from 'next/link'
import {draftMode} from 'next/headers'
import {VisualEditing} from 'next-sanity/visual-editing'
import {RichText} from '../../components/RichText'
import {type Doc, linkProps, stegaClean} from '../../lib/content'
import {SanityLive, load} from '../../sanity/live'
import {SITE_QUERY} from '../../sanity/queries'
import '../globals.css'

/** Menu items nest: an item's children render as a dropdown, and theirs as a sub-list. */
function MenuItems({items, depth = 0}: {items?: Doc[]; depth?: number}) {
  if (!items?.length) return null
  return (
    <ul className={depth === 0 ? 'menu' : 'submenu'}>
      {items.map((item) => {
        const {label, ...props} = linkProps(item.link)
        return (
          <li key={item._key}>
            <Link {...props}>{label}</Link>
            <MenuItems items={item.children} depth={depth + 1} />
          </li>
        )
      })}
    </ul>
  )
}

export default async function SiteLayout({children}: {children: React.ReactNode}) {
  const {isEnabled: isDraftMode} = await draftMode()
  const data = await load(SITE_QUERY)
  const {settings, navigation, announcement} = data ?? {}
  const brand = stegaClean(settings?.brandColor?.hex)
  const announce = announcement ? linkProps(announcement.link) : null
  return (
    <div className="site" style={brand ? ({'--brand': brand} as React.CSSProperties) : undefined}>
      {isDraftMode && (
        <p id="draft-mode" className="draft-bar">
          Draft mode · <a href="/api/draft-mode/disable">exit</a>
        </p>
      )}
      {announcement && (
        <div className="announcement">
          {announcement.message}{' '}
          {announce && (
            <Link href={announce.href}>
              {announce.label} →
            </Link>
          )}
        </div>
      )}
      <header className="header">
        <Link href="/" className="logo">
          {settings?.title ?? 'Meridian'}
          <span>{settings?.tagline?.en}</span>
        </Link>
        <nav>
          <MenuItems items={navigation} />
        </nav>
      </header>
      <main>{children}</main>
      <footer className="footer">
        <RichText value={settings?.footerNote} />
        <div className="footer-links">
          {settings?.social?.map((social: Doc) => (
            <a key={social._key} href={stegaClean(social.url)}>
              {social.network}
            </a>
          ))}
          {settings?.contactEmail && <a href={`mailto:${stegaClean(settings.contactEmail)}`}>{settings.contactEmail}</a>}
          <Link href="/articles">Articles</Link>
          <Link href="/products">Shop</Link>
          <Link href="/events">Events</Link>
        </div>
      </footer>
      <SanityLive />
      {isDraftMode && <VisualEditing />}
    </div>
  )
}
