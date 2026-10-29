import Link from 'next/link'
import {type Doc, formatDate, hrefFor, imageUrl, money, stegaClean} from '../lib/content'

const KIND: Record<string, string> = {article: 'Article', product: 'Product', event: 'Event'}

/** One card for any article, product or event. */
export function Card({item}: {item: Doc}) {
  const type = stegaClean(item._type) as string
  const src = imageUrl(item.image, 640, 420)
  return (
    <Link className="card" href={hrefFor(item)}>
      {src ? <img src={src} alt={item.image?.alt ?? ''} loading="lazy" /> : <div className="card-blank" />}
      <div className="card-body">
        <span className="eyebrow">{item.kicker || KIND[type]}</span>
        <strong>{item.title || item.name}</strong>
        {type === 'article' && <span className="muted">{item.excerpt}</span>}
        {type === 'event' && <span className="muted">{formatDate(item.startsAt, {dateStyle: 'full'})}</span>}
        {type === 'product' && (
          <span className="price">
            {item.onSale ? (
              <>
                <s>{money(item.price, item.currency)}</s> {money(item.salePrice, item.currency)}
              </>
            ) : (
              money(item.price, item.currency)
            )}
          </span>
        )}
      </div>
    </Link>
  )
}

export function CardGrid({items}: {items?: Doc[]}) {
  if (!items?.length) return <p className="muted">Nothing here yet.</p>
  return (
    <div className="grid cards">
      {items.filter(Boolean).map((item) => (
        <Card key={item._id} item={item} />
      ))}
    </div>
  )
}
