import Link from 'next/link'
import {notFound} from 'next/navigation'
import {CardGrid} from '../../../../components/Cards'
import {RichText} from '../../../../components/RichText'
import {type Doc, formatDate, hrefFor, imageUrl, money, stegaClean} from '../../../../lib/content'
import {load} from '../../../../sanity/live'
import {EVENT_QUERY} from '../../../../sanity/queries'

const FORMAT: Record<string, string> = {'in-person': 'In person', online: 'Online', hybrid: 'In person and online'}

export default async function EventPage({params}: {params: Promise<{slug: string}>}) {
  const {slug} = await params
  const event = await load(EVENT_QUERY, {slug})
  if (!event) notFound()
  const past = new Date(stegaClean(event.startsAt)) < new Date()
  const cover = imageUrl(event.cover, 1800, 700)
  return (
    <article className="event">
      {cover && <img className="banner" src={cover} alt={event.cover?.alt ?? ''} />}
      <header className="article-head">
        <span className="eyebrow">
          {FORMAT[stegaClean(event.format) as string]} {past && <span className="tag">Past event</span>}
        </span>
        <h1>{event.title}</h1>
        <p className="byline">
          {formatDate(event.startsAt, {dateStyle: 'full', timeStyle: 'short'})}
          {event.endsAt && <> – {formatDate(event.endsAt, {dateStyle: 'full', timeStyle: 'short'})}</>} (UTC)
        </p>
        {event.summary && <p className="lead">{event.summary}</p>}
      </header>
      <div className="article-body">
        <div>
          {event.schedule?.length > 0 && (
            <section>
              <h2>Programme</h2>
              {event.schedule.map((day: Doc) => (
                <div key={day._key} className="day">
                  <h3>{formatDate(day.date, {weekday: 'long', day: 'numeric', month: 'long'})}</h3>
                  <ol className="sessions">
                    {day.sessions?.map((session: Doc) => (
                      <li key={session._key}>
                        <time>{session.time}</time>
                        <span>
                          <strong>{session.title}</strong>
                          {session.speaker && (
                            <>
                              {' '}with <Link href={hrefFor({_type: 'author', slug: session.speaker.slug})}>{session.speaker.name}</Link>
                            </>
                          )}
                          {session.room && <span className="muted"> · {session.room}</span>}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </section>
          )}
          <RichText value={event.details} />
        </div>
        <aside className="article-aside">
          {event.venue && (
            <div className="place">
              <strong>{event.venue.name}</strong>
              <span className="muted">{[event.venue.address?.street, event.venue.address?.city, event.venue.address?.country].filter(Boolean).join(', ')}</span>
              {event.venue.location && (
                <a href={`https://www.openstreetmap.org/?mlat=${event.venue.location.lat}&mlon=${event.venue.location.lng}`} target="_blank" rel="noreferrer">
                  Map →
                </a>
              )}
            </div>
          )}
          {event.streamUrl && (
            <p>
              <a href={stegaClean(event.streamUrl)}>Join the livestream →</a>
            </p>
          )}
          {event.tickets?.length > 0 && (
            <ul className="tickets">
              {event.tickets.map((ticket: Doc) => (
                <li key={ticket._key}>
                  <span>{ticket.name}</span>
                  <span>{ticket.soldOut ? <span className="tag">Sold out</span> : ticket.price ? money(ticket.price, 'EUR') : 'Free'}</span>
                </li>
              ))}
            </ul>
          )}
          {event.speakers?.length > 0 && (
            <div className="speakers">
              <h3>Speakers</h3>
              {event.speakers.map((speaker: Doc) => (
                <Link key={speaker.slug} href={hrefFor({_type: 'author', slug: speaker.slug})} className="speaker">
                  {speaker.portrait && <img src={imageUrl(speaker.portrait, 96, 96)} alt="" />}
                  <span>
                    {speaker.name}
                    <span className="muted"> · {speaker.role}</span>
                  </span>
                </Link>
              ))}
            </div>
          )}
        </aside>
      </div>
      {event.gearList?.length > 0 && (
        <section className="section">
          <h2>What to bring</h2>
          <CardGrid items={event.gearList} />
        </section>
      )}
    </article>
  )
}
