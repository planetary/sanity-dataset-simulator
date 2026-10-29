import {notFound} from 'next/navigation'
import {Sections} from '../../../components/Sections'
import {load} from '../../../sanity/live'
import {PAGE_QUERY} from '../../../sanity/queries'

export default async function Page({params}: {params: Promise<{slug: string}>}) {
  const {slug} = await params
  const page = await load(PAGE_QUERY, {slug})
  if (!page) notFound()
  return <Sections sections={page.sections} />
}
