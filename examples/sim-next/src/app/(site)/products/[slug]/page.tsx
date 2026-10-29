import Link from 'next/link'
import {notFound} from 'next/navigation'
import {CardGrid} from '../../../../components/Cards'
import {RichText} from '../../../../components/RichText'
import {type Doc, bytes, hrefFor, imageUrl, money, stegaClean} from '../../../../lib/content'
import {load} from '../../../../sanity/live'
import {PRODUCT_QUERY} from '../../../../sanity/queries'

export default async function ProductPage({params}: {params: Promise<{slug: string}>}) {
  const {slug} = await params
  const product = await load(PRODUCT_QUERY, {slug})
  if (!product) notFound()
  const [head, ...rows] = product.specs?.rows ?? []
  return (
    <article className="product">
      <div className="product-gallery">
        {product.images?.map((image: Doc) => (
          <figure key={image._key}>
            <img src={imageUrl(image, 900, 900)} alt={image.alt ?? ''} />
            {image.caption && <figcaption>{image.caption}</figcaption>}
          </figure>
        ))}
      </div>
      <div className="product-info">
        {product.category && (
          <Link className="eyebrow" href={hrefFor({_type: 'category', slug: product.category.slug})}>
            {product.category.title}
          </Link>
        )}
        <h1>{product.title}</h1>
        <p className="muted translations">
          {['es', 'fr'].map((lang) => product.name?.[lang] && <span key={lang}>{lang.toUpperCase()}: {product.name[lang]}</span>)}
        </p>
        <p className="price big">
          {product.onSale ? (
            <>
              <s>{money(product.price, product.currency)}</s> {money(product.salePrice, product.currency)} <span className="tag sale">Sale</span>
            </>
          ) : (
            money(product.price, product.currency)
          )}
        </p>
        <RichText value={product.description} />
        {product.variants?.length > 0 && (
          <table className="variants">
            <thead>
              <tr>
                <th>Variant</th>
                <th>SKU</th>
                <th>Size</th>
                <th>Stock</th>
              </tr>
            </thead>
            <tbody>
              {product.variants.map((variant: Doc) => (
                <tr key={variant._key}>
                  <td>
                    {variant.color?.hex && <span className="swatch" style={{background: stegaClean(variant.color.hex)}} />}
                    {variant.name}
                  </td>
                  <td>
                    <code>{variant.sku}</code>
                  </td>
                  <td>{variant.size}</td>
                  <td>{variant.stock > 0 ? variant.stock : <span className="tag">Sold out</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {head && (
          <table className="specs">
            <tbody>
              {rows.map((row: Doc) => (
                <tr key={row._key}>
                  {row.cells.map((cell: string, i: number) => (i === 0 ? <th key={i}>{cell}</th> : <td key={i}>{cell}</td>))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {product.weightGrams && <p className="muted">Weight: {product.weightGrams} g</p>}
        {product.manual?.url && (
          <p>
            <a href={product.manual.url}>📄 {product.manual.originalFilename}</a> <span className="muted">{bytes(product.manual.size)}</span>
          </p>
        )}
      </div>
      {product.relatedProducts?.length > 0 && (
        <section className="section wide">
          <h2>Goes well with</h2>
          <CardGrid items={product.relatedProducts} />
        </section>
      )}
      {product.usedIn?.length > 0 && (
        <section className="section wide">
          <h2>On the kit list for</h2>
          <CardGrid items={product.usedIn} />
        </section>
      )}
    </article>
  )
}
