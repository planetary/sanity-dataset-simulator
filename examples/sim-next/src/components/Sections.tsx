import Link from 'next/link'
import {type Doc, imageUrl, linkProps, stegaClean} from '../lib/content'
import {CardGrid} from './Cards'
import {RichText} from './RichText'

function Hero({section}: {section: Doc}) {
  const layout = stegaClean(section.layout) ?? 'split'
  const src = imageUrl(section.image, layout === 'cover' ? 2000 : 1200, layout === 'cover' ? 900 : 900)
  return (
    <section className={`hero hero-${layout}`} style={section.background?.hex ? {background: stegaClean(section.background.hex)} : undefined}>
      <div className="hero-text">
        {section.eyebrow && <span className="eyebrow">{section.eyebrow}</span>}
        <h1>{section.heading}</h1>
        {section.subheading && <p className="lead">{section.subheading}</p>}
        {section.actions?.length > 0 && (
          <div className="actions">
            {section.actions.map((action: Doc, i: number) => {
              const {label, ...props} = linkProps(action)
              return (
                <Link key={i} className={i === 0 ? 'button' : 'button ghost'} {...props}>
                  {label}
                </Link>
              )
            })}
          </div>
        )}
      </div>
      {src && layout !== 'text' && <img className="hero-image" src={src} alt={section.image?.alt ?? ''} />}
    </section>
  )
}

function FeatureGrid({section}: {section: Doc}) {
  return (
    <section className="section">
      {section.heading && <h2>{section.heading}</h2>}
      <div className="grid" style={{gridTemplateColumns: `repeat(auto-fit, minmax(${stegaClean(section.columns) === 4 ? 180 : 240}px, 1fr))`}}>
        {section.features?.map((feature: Doc) => {
          const {label, ...props} = linkProps(feature.link)
          return (
            <div key={feature._key} className="feature">
              {feature.icon && <span className="feature-icon">{feature.icon}</span>}
              <h3>{feature.title}</h3>
              <p className="muted">{feature.body}</p>
              {feature.link && <Link {...props}>{label} →</Link>}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function StatsBand({section}: {section: Doc}) {
  return (
    <section className="stats">
      {section.stats?.map((stat: Doc) => (
        <div key={stat._key}>
          <strong>
            {new Intl.NumberFormat('en').format(stat.value)}
            {stat.unit}
          </strong>
          <span>{stat.label}</span>
        </div>
      ))}
    </section>
  )
}

function Gallery({section}: {section: Doc}) {
  const layout = stegaClean(section.layout) ?? 'grid'
  return (
    <section className="section">
      {section.heading && <h2>{section.heading}</h2>}
      <div className={`gallery gallery-${layout}`}>
        {section.images?.map((image: Doc) => (
          <figure key={image._key}>
            <img src={imageUrl(image, 600, layout === 'masonry' ? undefined : 420)} alt={image.alt ?? ''} loading="lazy" />
            {image.caption && <figcaption>{image.caption}</figcaption>}
          </figure>
        ))}
      </div>
    </section>
  )
}

function Testimonials({section}: {section: Doc}) {
  return (
    <section className="section quotes">
      {section.quotes?.map((quote: Doc) => (
        <blockquote key={quote._key}>
          <p>“{quote.text}”</p>
          <footer>
            {'★'.repeat(stegaClean(quote.rating) ?? 0)} — {quote.author ? `${quote.author.name}, ${quote.author.role}` : quote.name}
          </footer>
        </blockquote>
      ))}
    </section>
  )
}

function Faq({section}: {section: Doc}) {
  return (
    <section className="section">
      {section.heading && <h2>{section.heading}</h2>}
      {section.groups?.map((group: Doc) => (
        <div key={group._key} className="faq-group">
          <h3>{group.title}</h3>
          {group.items?.map((item: Doc) => (
            <details key={item._key}>
              <summary>{item.question}</summary>
              <RichText value={item.answer} />
            </details>
          ))}
        </div>
      ))}
    </section>
  )
}

function MapSection({section}: {section: Doc}) {
  return (
    <section className="section">
      {section.heading && <h2>{section.heading}</h2>}
      <div className="grid places">
        {section.places?.filter(Boolean).map((place: Doc) => (
          <div key={place._id} className="place">
            <strong>{place.name}</strong>
            <span className="muted">
              {[place.address?.street, place.address?.postalCode, place.address?.city, place.address?.country].filter(Boolean).join(', ')}
            </span>
            {place.location && (
              <a href={`https://www.openstreetmap.org/?mlat=${place.location.lat}&mlon=${place.location.lng}#map=13/${place.location.lat}/${place.location.lng}`} target="_blank" rel="noreferrer">
                {place.location.lat.toFixed(4)}, {place.location.lng.toFixed(4)} on the map →
              </a>
            )}
            <span className="muted">
              {place.capacity ? `${place.capacity} seats` : ''} {place.accessible ? '· step-free' : ''}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function CallToAction({section}: {section: Doc}) {
  const {label, ...props} = linkProps(section.action)
  const accent = stegaClean(section.accent?.hex)
  return (
    <section className="cta" style={accent ? {background: accent} : undefined}>
      <h2>{section.heading}</h2>
      {section.body && <p>{section.body}</p>}
      {section.action && (
        <Link className="button light" {...props}>
          {label}
        </Link>
      )}
    </section>
  )
}

/** Renders a page's sections in order; unknown types are named, not dropped silently. */
export function Sections({sections}: {sections?: Doc[]}) {
  return (
    <>
      {sections?.map((section) => {
        const type = stegaClean(section._type) as string
        switch (type) {
          case 'hero':
            return <Hero key={section._key} section={section} />
          case 'featureGrid':
            return <FeatureGrid key={section._key} section={section} />
          case 'statsBand':
            return <StatsBand key={section._key} section={section} />
          case 'featuredContent':
            return (
              <section key={section._key} className="section">
                {section.heading && <h2>{section.heading}</h2>}
                <CardGrid items={section.items} />
              </section>
            )
          case 'gallery':
            return <Gallery key={section._key} section={section} />
          case 'testimonials':
            return <Testimonials key={section._key} section={section} />
          case 'faq':
            return <Faq key={section._key} section={section} />
          case 'textSection':
            return (
              <section key={section._key} className="section narrow">
                {section.heading && <h2>{section.heading}</h2>}
                <RichText value={section.body} />
              </section>
            )
          case 'mapSection':
            return <MapSection key={section._key} section={section} />
          case 'callToAction':
            return <CallToAction key={section._key} section={section} />
          default:
            return (
              <section key={section._key} className="section muted">
                Unknown section type “{type}”
              </section>
            )
        }
      })}
    </>
  )
}
