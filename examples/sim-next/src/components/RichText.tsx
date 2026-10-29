import Link from 'next/link'
import {PortableText, type PortableTextComponents} from 'next-sanity'
import {type Doc, hrefFor, imageUrl, money, stegaClean} from '../lib/content'

function Figure({value}: {value: Doc}) {
  const src = imageUrl(value, 1400)
  if (!src) return null
  return (
    <figure className="figure">
      <img src={src} alt={value.alt ?? ''} loading="lazy" />
      {(value.caption || value.credit) && (
        <figcaption>
          {value.caption}
          {value.credit && <span className="credit"> · {value.credit}</span>}
        </figcaption>
      )}
    </figure>
  )
}

function youTubeId(url: string) {
  return /(?:youtu\.be\/|v=)([\w-]{11})/.exec(url)?.[1]
}

const components: PortableTextComponents = {
  types: {
    figure: Figure,
    callout: ({value}) => (
      <aside className={`callout callout-${stegaClean(value.tone) ?? 'note'}`}>
        <strong>{{note: 'Note', tip: 'Tip', warning: 'Warning'}[stegaClean(value.tone) as string] ?? 'Note'}</strong> {value.body}
      </aside>
    ),
    code: ({value}) => (
      <figure className="code">
        {value.filename && <figcaption>{value.filename}</figcaption>}
        <pre data-language={stegaClean(value.language)}>
          <code>{value.code}</code>
        </pre>
      </figure>
    ),
    table: ({value}) => {
      const [head, ...rows] = value.rows ?? []
      return (
        <div className="table-wrap">
          <table>
            {head && (
              <thead>
                <tr>{head.cells.map((cell: string, i: number) => <th key={i}>{cell}</th>)}</tr>
              </thead>
            )}
            <tbody>
              {rows.map((row: Doc) => (
                <tr key={row._key}>{row.cells.map((cell: string, i: number) => <td key={i}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    },
    videoEmbed: ({value}) => {
      const id = youTubeId(stegaClean(value.url) ?? '')
      return (
        <figure className="video">
          {id ? <iframe src={`https://www.youtube-nocookie.com/embed/${id}`} title={value.caption ?? 'Video'} allowFullScreen /> : <a href={stegaClean(value.url)}>{value.url}</a>}
          {value.caption && <figcaption>{value.caption}</figcaption>}
        </figure>
      )
    },
    libraryVideo: ({value}) => (
      <figure className="video video-library">
        <div className="video-placeholder">▶ Media Library video{value.videoRef ? <code>{stegaClean(value.videoRef)}</code> : ' (none chosen yet)'}</div>
        {value.caption && <figcaption>{value.caption}</figcaption>}
      </figure>
    ),
    productMention: ({value}) =>
      value.product ? (
        <Link className="mention" href={hrefFor({_type: 'product', slug: value.product.slug})}>
          {value.product.title} · {money(value.product.price, value.product.currency)}
        </Link>
      ) : null,
  },
  marks: {
    externalLink: ({value, children}) => (
      <a href={stegaClean(value?.href)} {...(value?.newTab ? {target: '_blank', rel: 'noreferrer'} : {})}>
        {children}
      </a>
    ),
    internalLink: ({value, children}) => <Link href={hrefFor(value?.target)}>{children}</Link>,
    footnote: ({value, children}) => (
      <span className="footnote" title={value?.text}>
        {children}
      </span>
    ),
    highlight: ({children}) => <mark>{children}</mark>,
    underline: ({children}) => <u>{children}</u>,
    'strike-through': ({children}) => <s>{children}</s>,
  },
  block: {
    lead: ({children}) => <p className="lead">{children}</p>,
    blockquote: ({children}) => <blockquote>{children}</blockquote>,
  },
}

export function RichText({value}: {value?: Doc[]}) {
  if (!value?.length) return null
  return (
    <div className="prose">
      <PortableText value={value as never} components={components} />
    </div>
  )
}
