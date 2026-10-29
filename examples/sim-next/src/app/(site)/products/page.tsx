import {CardGrid} from '../../../components/Cards'
import {load} from '../../../sanity/live'
import {PRODUCTS_QUERY} from '../../../sanity/queries'

export default async function Products() {
  const products = await load(PRODUCTS_QUERY)
  return (
    <section className="section">
      <h1>Shop</h1>
      <CardGrid items={products} />
    </section>
  )
}
