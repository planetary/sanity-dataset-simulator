import {CardGrid} from '../../../components/Cards'
import {load} from '../../../sanity/live'
import {EVENTS_QUERY} from '../../../sanity/queries'

export default async function Events() {
  const events = await load(EVENTS_QUERY)
  return (
    <section className="section">
      <h1>Events</h1>
      <CardGrid items={events} />
    </section>
  )
}
