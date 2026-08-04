#!/usr/bin/env node
// Deterministic fixture generator (PRD §35.11, testing-strategy §1).
// No Date.now(), no Math.random(): identical output on every run.
// Usage: node generate.mjs [--big]   (--big appends the ~2MB document)
import {writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'dataset.ndjson')
const BIG = process.argv.includes('--big')

const docs = []
// Strictly monotonic in n (no modulo wrap): n=1..28 -> Jan, 29..56 -> Feb, ...
const ts = (n) => {
  const month = Math.floor((n - 1) / 28) + 1
  const day = ((n - 1) % 28) + 1
  return `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T12:00:00Z`
}
const rev = (id) => `fixture-rev-${id}`
const base = (id, type, n) => ({_id: id, _type: type, _createdAt: ts(n), _updatedAt: ts(n), _rev: rev(id)})

// 5 authors; author-1 completes a weak reference cycle with article-01
for (let i = 1; i <= 5; i++) {
  docs.push({
    ...base(`author-${i}`, 'author', i),
    name: `Author ${i}`,
    slug: {_type: 'slug', current: `author-${i}`},
    bio: `Bio for author ${i}.`,
    ...(i === 1 ? {favoriteArticle: {_type: 'reference', _ref: 'article-01', _weak: true}} : {}),
  })
}

// 30 articles: enough for [0...20] slice + top-K proof pressure (§22.6)
for (let i = 1; i <= 30; i++) {
  const id = `article-${String(i).padStart(2, '0')}`
  docs.push({
    ...base(id, 'article', i),
    title: `Article ${i}`,
    slug: {_type: 'slug', current: `article-${i}`},
    publishedAt: ts(31 - i), // reverse order vs numeric id: ordering is non-trivial
    tags: ['news', i % 2 === 0 ? 'even' : 'odd'], // non-keyed array
    author: {_type: 'reference', _ref: `author-${(i % 5) + 1}`},
    related: i > 1 ? [{_type: 'reference', _ref: `article-${String(i - 1).padStart(2, '0')}`, _weak: true, _key: `rel-${i}-1`}] : [],
    body: [
      {
        _type: 'block', _key: `b-${i}-1`, style: 'normal',
        markDefs: [{_type: 'link', _key: `m-${i}-1`, href: `https://example.com/${i}`}],
        children: [
          {_type: 'span', _key: `s-${i}-1`, text: `Body of article ${i} with a `, marks: []},
          {_type: 'span', _key: `s-${i}-2`, text: 'link', marks: [`m-${i}-1`]},
          {_type: 'inlineStat', _key: `s-${i}-3`, label: 'reads', value: i * 100},
        ],
      },
    ],
    sections: [
      {_type: 'quoteSection', _key: `sec-${i}-q`, quote: `Quote in article ${i}`, attribution: `Author ${(i % 5) + 1}`},
      {_type: 'statsSection', _key: `sec-${i}-s`, heading: 'Stats', count: i},
    ],
  })
}

// Draft diverging from its published counterpart (draft/published divergence)
docs.push({
  ...base('drafts.article-02', 'article', 2),
  title: 'Article 2 (DRAFT: retitled)',
  slug: {_type: 'slug', current: 'article-2'},
  publishedAt: ts(29),
  tags: ['news', 'even', 'draft-only-tag'],
  author: {_type: 'reference', _ref: 'author-3'},
  body: [{_type: 'block', _key: 'b-2-1', style: 'normal', markDefs: [], children: [{_type: 'span', _key: 's-2-1', text: 'Draft-only body.', marks: []}]}],
  sections: [{_type: 'quoteSection', _key: 'sec-2-q', quote: 'Draft quote', attribution: 'Nobody'}],
})

// Draft-only document (no published counterpart)
docs.push({
  ...base('drafts.article-99', 'article', 9),
  title: 'Article 99 (draft only)',
  slug: {_type: 'slug', current: 'article-99'},
  publishedAt: ts(1),
  tags: [],
  author: {_type: 'reference', _ref: 'author-1'},
})

// 3 pages, incl. one with dots in its _id (§35.9 encoding)
const pages = [
  {id: 'page-home', title: 'Home'},
  {id: 'page-about', title: 'About'},
  {id: 'legacy.page.v2', title: 'Legacy page'},
]
pages.forEach((p, n) => {
  docs.push({
    ...base(p.id, 'page', n + 1),
    title: p.title,
    slug: {_type: 'slug', current: p.title.toLowerCase().replace(/ /g, '-')},
    hero: {heading: `${p.title} hero`, subheading: 'Sub', cta: {label: 'Go', href: 'https://example.com'}},
    sections: [
      {_type: 'textSection', _key: `pg-${n}-t`, heading: 'Text', body: 'Body text'},
      {_type: 'featuredArticles', _key: `pg-${n}-f`, heading: 'Featured', articles: [
        {_type: 'reference', _ref: 'article-01', _key: `pg-${n}-a1`},
        {_type: 'reference', _ref: 'article-15', _key: `pg-${n}-a2`},
      ]},
    ],
  })
})

// Singleton settings with strong refs
docs.push({
  ...base('siteSettings', 'siteSettings', 1),
  siteTitle: 'Kitchen Sink',
  featuredArticle: {_type: 'reference', _ref: 'article-01'},
  homePage: {_type: 'reference', _ref: 'page-home'},
})

// Optional ~2MB document (§15.6 guardrail probing); not committed by default
if (BIG) {
  docs.push({
    ...base('article-big', 'article', 15),
    title: 'Big article',
    slug: {_type: 'slug', current: 'article-big'},
    publishedAt: ts(15),
    tags: ['big'],
    author: {_type: 'reference', _ref: 'author-1'},
    body: Array.from({length: 4000}, (_, b) => ({
      _type: 'block', _key: `big-b-${b}`, style: 'normal', markDefs: [],
      children: [{_type: 'span', _key: `big-s-${b}`, text: 'x'.repeat(500), marks: []}],
    })),
  })
}

writeFileSync(OUT, docs.map((d) => JSON.stringify(d)).join('\n') + '\n')
console.log(`wrote ${docs.length} documents to ${OUT}`)
