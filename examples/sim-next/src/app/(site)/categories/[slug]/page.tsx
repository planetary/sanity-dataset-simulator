import Link from 'next/link'
import {notFound} from 'next/navigation'
import {CardGrid} from '../../../../components/Cards'
import {type Doc, hrefFor, stegaClean} from '../../../../lib/content'
import {load} from '../../../../sanity/live'
import {CATEGORY_QUERY, IN_CATEGORIES_QUERY} from '../../../../sanity/queries'

export default async function CategoryPage({params}: {params: Promise<{slug: string}>}) {
  const {slug} = await params
  const category = await load(CATEGORY_QUERY, {slug})
  if (!category) notFound()
  const ids = [category._id, ...(category.children ?? []).map((child: Doc) => child._id)]
  const filed = await load(IN_CATEGORIES_QUERY, {ids})
  const accent = stegaClean(category.color?.hex)
  return (
    <section className="section">
      <div className="crumbs">
        <Link href="/">Home</Link> ›{' '}
        {category.parent && (
          <>
            <Link href={hrefFor({_type: 'category', slug: category.parent.slug})}>{category.parent.title}</Link> ›{' '}
          </>
        )}
        <span>{category.title}</span>
      </div>
      <h1 style={accent ? {borderLeft: `6px solid ${accent}`, paddingLeft: 12} : undefined}>{category.title}</h1>
      {category.description && <p className="lead">{category.description}</p>}
      {category.children?.length > 0 && (
        <p className="tags">
          {category.children.map((child: Doc) => (
            <Link key={child.slug} className="tag" href={hrefFor({_type: 'category', slug: child.slug})}>
              {child.title}
            </Link>
          ))}
        </p>
      )}
      <h2>Articles</h2>
      <CardGrid items={filed?.articles} />
      {filed?.products?.length > 0 && (
        <>
          <h2>Products</h2>
          <CardGrid items={filed.products} />
        </>
      )}
    </section>
  )
}
