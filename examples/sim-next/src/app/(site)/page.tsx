import {Sections} from '../../components/Sections'
import {load} from '../../sanity/live'
import {HOME_QUERY} from '../../sanity/queries'

export default async function Home() {
  const page = await load(HOME_QUERY)
  if (!page) return <p className="section muted">Set a homepage in Site settings.</p>
  return <Sections sections={page.sections} />
}
