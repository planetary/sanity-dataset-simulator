#!/usr/bin/env node
/**
 * Builds seed.tar.gz for the Meridian demo: a `sanity dataset export`-style
 * tarball (data.ndjson plus images/ and files/) that `npx sanity-sim --seed`
 * imports. Photos come from picsum.photos (Unsplash License); the PDFs are
 * generated here. Run it again after editing the content below:
 *
 *   node scripts/build-seed.mjs
 */
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'seed.tar.gz')
const PROJECT = 'b1n03q3z'
const DATASET = 'production'
const PUBLIC = 'https://localhost:3939'

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-seed-'))
const root = path.join(work, 'meridian')
fs.mkdirSync(path.join(root, 'images'), {recursive: true})
fs.mkdirSync(path.join(root, 'files'), {recursive: true})

const documents = []
const add = (doc) => documents.push(doc)
const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex')

/* ------------------------------------------------------------------ assets */

const images = new Map()
async function photo(name, picsumId, width, height) {
  const response = await fetch(`https://picsum.photos/id/${picsumId}/${width}/${height}.jpg`)
  if (!response.ok) throw new Error(`picsum ${picsumId}: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const hash = sha1(bytes)
  const file = `${hash}-${width}x${height}.jpg`
  fs.writeFileSync(path.join(root, 'images', file), bytes)
  const id = `image-${hash}-${width}x${height}-jpg`
  add({
    _id: id,
    _type: 'sanity.imageAsset',
    assetId: hash,
    sha1hash: hash,
    extension: 'jpg',
    mimeType: 'image/jpeg',
    size: bytes.length,
    originalFilename: `${name}.jpg`,
    path: `images/${PROJECT}/${DATASET}/${file}`,
    url: `${PUBLIC}/images/${PROJECT}/${DATASET}/${file}`,
    metadata: {_type: 'sanity.imageMetadata', dimensions: {_type: 'sanity.imageDimensions', width, height, aspectRatio: width / height}, hasAlpha: false, isOpaque: true},
    source: {name: 'picsum.photos', id: String(picsumId), url: `https://picsum.photos/id/${picsumId}/info`},
    creditLine: 'Unsplash via Picsum',
  })
  images.set(name, id)
}

const files = new Map()
function pdf(name, title, lines) {
  const text = [title, '', ...lines].map((line, i) => `BT /F1 ${i === 0 ? 20 : 12} Tf 72 ${720 - i * 22} Td (${line.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(body))
    body += `${i + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const bytes = Buffer.from(body)
  const hash = sha1(bytes)
  fs.writeFileSync(path.join(root, 'files', `${hash}.pdf`), bytes)
  const id = `file-${hash}-pdf`
  add({_id: id, _type: 'sanity.fileAsset', assetId: hash, sha1hash: hash, extension: 'pdf', mimeType: 'application/pdf', size: bytes.length, originalFilename: `${name}.pdf`, path: `files/${PROJECT}/${DATASET}/${hash}.pdf`, url: `${PUBLIC}/files/${PROJECT}/${DATASET}/${hash}.pdf`})
  files.set(name, id)
}

/* ------------------------------------------------------------------ helpers */

let counter = 0
const key = () => `k${(counter++).toString(36).padStart(5, '0')}`
const ref = (_ref, extra = {}) => ({_type: 'reference', _ref, ...extra})
const keyedRef = (_ref) => ({_key: key(), ...ref(_ref)})
const slug = (current) => ({_type: 'slug', current})
const figure = (name, alt, extra = {}) => ({_type: 'figure', asset: ref(images.get(name)), alt, ...extra})
const keyedFigure = (name, alt, extra) => ({_key: key(), ...figure(name, alt, extra)})
const geo = (lat, lng, alt) => ({_type: 'geopoint', lat, lng, ...(alt ? {alt} : {})})
const locale = (en, es, fr) => ({_type: 'localeString', en, es, fr})
const link = (label, target) =>
  target.startsWith('http') || target.startsWith('mailto:')
    ? {_type: 'link', label, kind: 'external', external: target, newTab: target.startsWith('http')}
    : {_type: 'link', label, kind: 'internal', internal: ref(target)}

function color(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (d !== 0) {
    const [rr, gg, bb] = [r / 255, g / 255, b / 255]
    h = max === rr ? ((gg - bb) / d) % 6 : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4
    h = Math.round(h * 60 + 360) % 360
  }
  return {
    _type: 'color',
    hex,
    alpha: 1,
    rgb: {_type: 'rgbaColor', r, g, b, a: 1},
    hsl: {_type: 'hslaColor', h, s, l, a: 1},
    hsv: {_type: 'hsvaColor', h, s: max === 0 ? 0 : d / max, v: max, a: 1},
  }
}

/**
 * One portable text block from a light markup: **strong**, *em*, `code`,
 * ==highlight==, ~~strike~~, __underline__, [text](https://…) external,
 * [text](@doc-id) internal, [text](^footnote text), and {{product:id}} inline.
 */
function block(source, {style = 'normal', listItem, level} = {}) {
  const children = []
  const markDefs = []
  const pattern = /\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|==(.+?)==|~~(.+?)~~|__(.+?)__|\[(.+?)\]\((.+?)\)|\{\{product:(.+?)\}\}/g
  let last = 0
  const span = (text, marks = []) => text && children.push({_key: key(), _type: 'span', text, marks})
  for (const match of source.matchAll(pattern)) {
    span(source.slice(last, match.index))
    last = match.index + match[0].length
    const [, strong, em, code, highlight, strike, underline, linkText, target, product] = match
    if (strong) span(strong, ['strong'])
    else if (em) span(em, ['em'])
    else if (code) span(code, ['code'])
    else if (highlight) span(highlight, ['highlight'])
    else if (strike) span(strike, ['strike-through'])
    else if (underline) span(underline, ['underline'])
    else if (product) children.push({_key: key(), _type: 'productMention', product: ref(product)})
    else if (linkText) {
      const markKey = key()
      if (target.startsWith('@')) markDefs.push({_key: markKey, _type: 'internalLink', reference: ref(target.slice(1))})
      else if (target.startsWith('^')) markDefs.push({_key: markKey, _type: 'footnote', text: target.slice(1)})
      else markDefs.push({_key: markKey, _type: 'externalLink', href: target, newTab: true})
      span(linkText, [markKey])
    }
  }
  span(source.slice(last))
  if (children.length === 0) span('')
  return {_key: key(), _type: 'block', style, markDefs, children, ...(listItem ? {listItem, level: level ?? 1} : {})}
}

const p = (text) => block(text)
const h = (level, text) => block(text, {style: `h${level}`})
const bullets = (items, level = 1) => items.map((item) => block(item, {listItem: 'bullet', level}))
const numbered = (items) => items.map((item) => block(item, {listItem: 'number', level: 1}))
const callout = (tone, body) => ({_key: key(), _type: 'callout', tone, body})
const code = (language, filename, source) => ({_key: key(), _type: 'code', language, filename, code: source})
const table = (rows) => ({_key: key(), _type: 'table', rows: rows.map((cells) => ({_key: key(), _type: 'tableRow', cells}))})
const tableValue = (rows) => ({_type: 'table', rows: rows.map((cells) => ({_key: key(), _type: 'tableRow', cells}))})

/* ------------------------------------------------------------------ assets */

console.log('fetching photos…')
const PHOTOS = [
  ['haute-route', 1018, 1600, 1000],
  ['valley', 1015, 1600, 1000],
  ['lake', 1043, 1600, 1000],
  ['forest', 10, 1600, 1000],
  ['coast', 1050, 1600, 1000],
  ['waterfall', 1039, 1600, 1000],
  ['snow-forest', 1036, 1600, 1000],
  ['canoe', 1011, 1600, 1000],
  ['peaks', 29, 1600, 1000],
  ['hall', 1067, 1600, 1000],
  ['pack', 26, 1000, 1000],
  ['mug', 30, 1000, 1000],
  ['notebook', 20, 1000, 1000],
  ['shell', 21, 1000, 1000],
  ['camera', 250, 1000, 1000],
  ['ada', 64, 600, 600],
  ['mateo', 91, 600, 600],
  ['lin', 1027, 600, 600],
  ['priya', 1005, 600, 600],
]
for (const entry of PHOTOS) await photo(...entry)
pdf('ridgeline-manual', 'Ridgeline 32L - Owner\'s manual', ['Fit: loosen all straps, load the pack, then tighten hip belt first.', 'Care: hand wash cold, hang to dry. Do not tumble dry.', 'Warranty: lifetime, against defects in materials and workmanship.'])
pdf('haute-route-gpx', 'Haute Route - Stage notes', ['Day 1: Argentiere to Champex, 18.2 km, +1,240 m.', 'Day 2: Champex to Bourg-St-Pierre, 21.4 km, +1,610 m.', 'Day 3: Bourg-St-Pierre to Cabane de Prafleuri, 16.0 km, +1,890 m.'])

/* ------------------------------------------------------------------ content */

const AUTHORS = {
  ada: {name: 'Ada Okafor', role: 'Editor', at: geo(46.2044, 6.1432), color: '#c2410c', bio: 'Edits Meridian from Geneva. Twelve seasons guiding in the Valais, and a stubborn belief that **every route deserves a good map**.'},
  mateo: {name: 'Mateo Ruiz', role: 'Photographer', at: geo(42.8782, -8.5448), color: '#0e7490', bio: 'Shoots on film when the weather allows, and on a phone in a ziplock bag when it doesn\'t.'},
  lin: {name: 'Lin Hallström', role: 'Guide', at: geo(67.8558, 20.2253), color: '#4d7c0f', bio: 'Leads winter traverses in Swedish Lapland. Writes about *field craft*, navigation and the art of the early start.'},
  priya: {name: 'Priya Nair', role: 'Writer', at: geo(51.5072, -0.1276), color: '#7c3aed', bio: 'Covers gear, repair and the economics of the outdoors. Has opinions about zippers.'},
}
for (const [id, a] of Object.entries(AUTHORS)) {
  add({
    _id: `author-${id}`,
    _type: 'author',
    name: a.name,
    slug: slug(id === 'lin' ? 'lin-hallstrom' : a.name.toLowerCase().replace(/\s+/g, '-')),
    role: a.role,
    portrait: figure(id, `Portrait of ${a.name}`),
    bio: [p(a.bio)],
    email: `${id}@meridian.example`,
    website: `https://meridian.example/people/${id}`,
    favoriteColor: color(a.color),
    basedIn: a.at,
  })
}

const CATEGORIES = [
  ['trails', 'Trails', null, 'Routes, stages and the ground underfoot.', '#15803d'],
  ['alpine', 'Alpine', 'trails', 'High routes, passes and glacier travel.', '#0369a1'],
  ['coastal', 'Coastal', 'trails', 'Cliff paths and tidal crossings.', '#0891b2'],
  ['gear', 'Gear', null, 'What we carry, and why.', '#b45309'],
  ['packs', 'Packs', 'gear', 'Carrying systems, tested to failure.', '#a16207'],
  ['field-craft', 'Field craft', null, 'Navigation, weather and judgement.', '#6d28d9'],
]
for (const [id, title, parent, description, hex] of CATEGORIES) {
  add({_id: `category-${id}`, _type: 'category', title, slug: slug(id), ...(parent ? {parent: ref(`category-${parent}`)} : {}), description, color: color(hex)})
}

add({_id: 'venue-basecamp', _type: 'venue', name: 'Basecamp Hall', address: {street: 'Rue du Mont-Blanc 14', city: 'Chamonix', postalCode: '74400', country: 'France'}, location: geo(45.9237, 6.8694, 1035), capacity: 180, accessible: true, photo: figure('hall', 'The hall set up for a talk')})
add({_id: 'venue-boathouse', _type: 'venue', name: 'The Boathouse', address: {street: 'Strandvägen 3', city: 'Abisko', postalCode: '981 07', country: 'Sweden'}, location: geo(68.3495, 18.8312), capacity: 40, accessible: false, photo: figure('lake', 'The boathouse jetty at dawn')})

/* products */
add({
  _id: 'product-ridgeline',
  _type: 'product',
  title: 'Ridgeline 32L Pack',
  slug: slug('ridgeline-32l-pack'),
  name: locale('Ridgeline 32L Pack', 'Mochila Ridgeline 32L', 'Sac Ridgeline 32 L'),
  images: [keyedFigure('pack', 'The Ridgeline pack, top down, with gear laid out'), keyedFigure('camera', 'Camera stowed in the lid pocket')],
  description: [p('A **32-litre** pack built around one idea: the hip belt does the work. Aluminium stay, *removable* lid, and a back panel that dries while you walk.'), ...bullets(['Roll-top main compartment with side zip', 'Ice-axe loops and a tool keeper', '1,180 g with lid, 960 g without'])],
  category: ref('category-packs'),
  price: 219,
  currency: 'EUR',
  onSale: false,
  variants: [
    {_key: key(), _type: 'variant', name: 'Moss / M', sku: 'RDG-32-MOSS-M', color: color('#4d7c0f'), size: 'M', stock: 14},
    {_key: key(), _type: 'variant', name: 'Moss / L', sku: 'RDG-32-MOSS-L', color: color('#4d7c0f'), size: 'L', stock: 6},
    {_key: key(), _type: 'variant', name: 'Ember / M', sku: 'RDG-32-EMBR-M', color: color('#c2410c'), size: 'M', stock: 0},
  ],
  specs: tableValue([['Spec', 'Value'], ['Volume', '32 L'], ['Weight', '1,180 g'], ['Fabric', '210D recycled nylon'], ['Back length', 'M 46 cm · L 51 cm']]),
  weightGrams: 1180,
  manual: {_type: 'file', asset: ref(files.get('ridgeline-manual'))},
  relatedProducts: [keyedRef('product-shell'), keyedRef('product-mug')],
  seo: {_type: 'seo', title: 'Ridgeline 32L Pack', description: 'A 32-litre alpine pack built around a load-bearing hip belt.'},
})
add({
  _id: 'product-shell',
  _type: 'product',
  title: 'Featherlight Shell',
  slug: slug('featherlight-shell'),
  name: locale('Featherlight Shell', 'Chaqueta Featherlight', 'Veste Featherlight'),
  images: [keyedFigure('shell', 'The shell jacket, packed into its own pocket')],
  description: [p('Three-layer shell at **240 g**. Pit zips, a helmet-compatible hood, and a hem that stays put in the wind.')],
  category: ref('category-gear'),
  price: 289,
  currency: 'EUR',
  onSale: true,
  salePrice: 229,
  variants: [
    {_key: key(), _type: 'variant', name: 'Glacier / S', sku: 'FLS-GLC-S', color: color('#0e7490'), size: 'S', stock: 4},
    {_key: key(), _type: 'variant', name: 'Glacier / M', sku: 'FLS-GLC-M', color: color('#0e7490'), size: 'M', stock: 9},
  ],
  specs: tableValue([['Spec', 'Value'], ['Weight', '240 g'], ['Membrane', '3-layer, 20k/20k'], ['Packed size', '18 × 10 cm']]),
  weightGrams: 240,
  relatedProducts: [keyedRef('product-ridgeline')],
})
add({_id: 'product-mug', _type: 'product', title: 'Trail Mug', slug: slug('trail-mug'), name: locale('Trail Mug', 'Taza de montaña', 'Tasse de randonnée'), images: [keyedFigure('mug', 'Enamel mug on a camp table')], description: [p('Enamel steel, 350 ml, and a handle that folds flat. Goes on the stove.')], category: ref('category-gear'), price: 18, currency: 'EUR', variants: [{_key: key(), _type: 'variant', name: 'Cream', sku: 'MUG-CRM', color: color('#f5f0e6'), size: 'One size', stock: 120}], weightGrams: 140})
add({_id: 'product-notebook', _type: 'product', title: 'Field Notebook', slug: slug('field-notebook'), name: locale('Field Notebook', 'Cuaderno de campo', 'Carnet de terrain'), images: [keyedFigure('notebook', 'A waterproof notebook open to a sketched map')], description: [p('Stone-paper pages that shrug off rain. Dot grid on the left, plain on the right.')], category: ref('category-field-craft'), price: 14, currency: 'EUR', variants: [{_key: key(), _type: 'variant', name: 'A6', sku: 'NTB-A6', size: 'One size', stock: 300}], weightGrams: 90})

/* articles */
const hauteRouteBody = [
  block('Six days, three countries and one long argument with a weather forecast. This is the route as we walked it in late September.', {style: 'lead'}),
  h(2, 'Why the Haute Route, and why now'),
  p('The classic Chamonix–Zermatt line is usually a spring ski tour. Walked in autumn it becomes something else: **quieter huts**, *firm* moraine, and larches turning gold below the passes. We took the walker\'s variant, with two glacier-free detours we\'d [describe in detail](@article-coast) later.'),
  p('Our packs were the [Ridgeline 32L](@product-ridgeline) {{product:product-ridgeline}} and a [Featherlight Shell](@product-shell) each — nothing else made the cut after the first weigh-in[¹](^Weighed at the Argentière gîte on a luggage scale borrowed from the warden.).'),
  h(3, 'The stages'),
  ...numbered(['Argentière to Champex, over the **Fenêtre d\'Arpette**', 'Champex to Bourg-St-Pierre, the long valley day', 'Bourg-St-Pierre to Cabane de Prafleuri, two passes and a dam']),
  figureBlock('haute-route', 'Morning light on the Grandes Jorasses from the Fenêtre d\'Arpette', 'The view that made the 5 a.m. start worth it', 'Mateo Ruiz'),
  h(3, 'What went wrong'),
  ...bullets(['The forecast, twice', 'A hut that had closed for the season *the day before*']),
  ...bullets(['We had their number, not their website', 'Their website still said "open"'], 2),
  ...bullets(['Ada\'s left boot, retired with honours on day four']),
  callout('warning', 'Check hut closing dates by phone in September. Many close after the third weekend, and online calendars lag behind.'),
  h(4, 'Daily numbers'),
  table([['Stage', 'Distance', 'Ascent', 'Time'], ['1', '18.2 km', '+1,240 m', '7 h 40'], ['2', '21.4 km', '+1,610 m', '8 h 15'], ['3', '16.0 km', '+1,890 m', '7 h 05']]),
  block('“The mountain doesn\'t care about your itinerary.” — every hut warden, eventually', {style: 'blockquote'}),
  h(3, 'Querying the route data'),
  p('Every stage is in our dataset, so the site\'s stage list is one `GROQ` query. If you\'re running this demo against **sanity-sim**, try it in the Vision tool:'),
  code('groq', 'stages.groq', '*[_type == "article" && slug.current == "crossing-the-haute-route"][0]{\n  title,\n  "stages": body[_type == "table"][0].rows[1...].cells\n}'),
  {_key: key(), _type: 'videoEmbed', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', caption: 'A video embed (Big Buck Bunny, Blender Foundation, CC BY 3.0)'},
  p('We\'d go again tomorrow. ~~Maybe~~ Definitely in September. ==Pack less than you think.== __Bring more water than you think.__'),
]
function figureBlock(name, alt, caption, credit) {
  return {_key: key(), ...figure(name, alt, {caption, credit})}
}

add({
  _id: 'article-haute-route',
  _type: 'article',
  title: 'Crossing the Haute Route in autumn',
  slug: slug('crossing-the-haute-route'),
  kicker: 'Trip report',
  excerpt: 'Six days from Chamonix to Zermatt on the walker\'s variant, with golden larches, closed huts and one retired boot.',
  cover: figure('haute-route', 'The Haute Route above Champex', {caption: 'Day one, above Champex', credit: 'Mateo Ruiz'}),
  body: hauteRouteBody,
  author: ref('author-ada'),
  contributors: [keyedRef('author-mateo'), keyedRef('author-lin')],
  categories: [keyedRef('category-alpine'), keyedRef('category-trails')],
  tags: ['haute route', 'alps', 'autumn', 'huts'],
  publishedAt: '2026-10-02T07:30:00Z',
  updatedOn: '2026-10-20',
  readingTime: 9,
  featured: true,
  location: geo(45.9763, 7.0587, 2665),
  related: [keyedRef('product-ridgeline'), keyedRef('event-winter-traverse'), keyedRef('article-coast')],
  attachments: [{_key: key(), _type: 'file', asset: ref(files.get('haute-route-gpx')), description: 'Stage notes (PDF)'}],
  seo: {_type: 'seo', title: 'Crossing the Haute Route in autumn', description: 'Six days on the walker\'s Haute Route in late September.'},
})
add({
  _id: 'article-coast',
  _type: 'article',
  title: 'Tide tables and cliff paths',
  slug: slug('tide-tables-and-cliff-paths'),
  kicker: 'Field craft',
  excerpt: 'How to read a tide table for a crossing, and when to turn back.',
  cover: figure('coast', 'A cliff path above a tidal beach'),
  body: [p('Tidal crossings reward people who **can count**. Here is the method Lin teaches on every coastal course.'), ...numbered(['Find low water for the day and the place', 'Subtract half the window for the outbound leg', 'Add a safety margin you are slightly embarrassed by']), callout('tip', 'Spring tides run faster and further. Plan the margin around them, not around the average.')],
  author: ref('author-lin'),
  categories: [keyedRef('category-coastal'), keyedRef('category-field-craft')],
  tags: ['tides', 'coast', 'safety'],
  publishedAt: '2026-09-18T09:00:00Z',
  readingTime: 5,
  featured: false,
  location: geo(50.2, -5.5),
  related: [keyedRef('article-haute-route')],
})
add({
  _id: 'article-zippers',
  _type: 'article',
  title: 'In defence of the humble zipper',
  slug: slug('in-defence-of-the-humble-zipper'),
  kicker: 'Gear',
  excerpt: 'The most repaired part of any pack, and the least discussed.',
  cover: figure('pack', 'A pack zipper, close up'),
  body: [p('Ask a repair shop what fails first and the answer is never the fabric. It is the **slider**, then the tape, then — occasionally — the owner\'s patience.'), p('Priya spent a week at a repair bench in Leeds to find out [why](https://en.wikipedia.org/wiki/Zipper).')],
  author: ref('author-priya'),
  categories: [keyedRef('category-gear'), keyedRef('category-packs')],
  tags: ['repair', 'gear'],
  publishedAt: '2026-08-30T10:00:00Z',
  readingTime: 4,
  related: [keyedRef('product-ridgeline')],
})
/* Published, with a draft edit on top. */
add({
  _id: 'drafts.article-zippers',
  _type: 'article',
  title: 'In defence of the humble zipper (and how to fix one)',
  slug: slug('in-defence-of-the-humble-zipper'),
  kicker: 'Gear',
  excerpt: 'The most repaired part of any pack, and the least discussed — now with a field repair guide.',
  cover: figure('pack', 'A pack zipper, close up'),
  body: [p('Ask a repair shop what fails first and the answer is never the fabric. It is the **slider**, then the tape, then — occasionally — the owner\'s patience.'), h(2, 'A field repair in four steps'), ...numbered(['Close the slider gently with pliers', 'Test on a short stretch', 'Wax the teeth', 'Stop pulling on it with your teeth'])],
  author: ref('author-priya'),
  categories: [keyedRef('category-gear'), keyedRef('category-packs')],
  tags: ['repair', 'gear', 'how-to'],
  publishedAt: '2026-08-30T10:00:00Z',
  readingTime: 6,
  related: [keyedRef('product-ridgeline')],
})
/* Draft only: never published. */
add({
  _id: 'drafts.article-winter-kit',
  _type: 'article',
  title: 'Winter kit, ranked by regret',
  slug: slug('winter-kit-ranked-by-regret'),
  kicker: 'Gear · draft',
  excerpt: 'Everything we carried across Lapland, ordered by how much we wished we hadn\'t.',
  cover: figure('snow-forest', 'Snow-covered spruce in Lapland'),
  body: [p('Work in progress. *Do not publish until Lin has checked the stove section.*')],
  author: ref('author-lin'),
  categories: [keyedRef('category-gear')],
  tags: ['winter', 'lapland'],
  readingTime: 7,
})
/* In the scheduled "Autumn issue" release. */
add({_id: '_.releases.rautumn', _type: 'system.release', name: 'rautumn', state: 'active', metadata: {title: 'Autumn issue', description: 'Larches, huts and the last warm weekend.', releaseType: 'scheduled', intendedPublishAt: '2026-11-15T08:00:00Z'}, userId: 'local-dev'})
add({
  _id: 'versions.rautumn.article-larches',
  _type: 'article',
  title: 'Chasing the larches',
  slug: slug('chasing-the-larches'),
  kicker: 'Autumn issue',
  excerpt: 'Three valleys where the larches turn gold in the third week of October.',
  cover: figure('valley', 'Golden larches in a high valley'),
  body: [p('For about ten days a year, the larch forests of the Valais are the most beautiful thing in the Alps. Here is where to stand.')],
  author: ref('author-mateo'),
  categories: [keyedRef('category-alpine')],
  tags: ['autumn', 'larches'],
  publishedAt: '2026-11-15T08:00:00Z',
  readingTime: 3,
  related: [keyedRef('article-haute-route')],
})

/* events */
add({
  _id: 'event-winter-traverse',
  _type: 'event',
  title: 'Winter Traverse Weekend',
  slug: slug('winter-traverse-weekend'),
  format: 'hybrid',
  startsAt: '2026-11-21T09:00:00Z',
  endsAt: '2026-11-22T17:00:00Z',
  venue: ref('venue-basecamp'),
  streamUrl: 'https://meridian.example/live/winter-traverse',
  cover: figure('snow-forest', 'A winter forest on the traverse route'),
  summary: 'Two days of talks and workshops on winter travel: navigation in whiteout, stoves that work at −20 °C, and the art of the early start.',
  speakers: [keyedRef('author-lin'), keyedRef('author-ada'), keyedRef('author-priya')],
  schedule: [
    {_key: key(), _type: 'day', date: '2026-11-21', sessions: [
      {_key: key(), _type: 'session', time: '09:30', title: 'Navigation when the map goes white', speaker: ref('author-lin'), room: 'Main hall'},
      {_key: key(), _type: 'session', time: '11:00', title: 'Hut etiquette, by a hut warden', room: 'Main hall'},
      {_key: key(), _type: 'session', time: '14:00', title: 'Workshop: stove maintenance', speaker: ref('author-priya'), room: 'Workshop'},
    ]},
    {_key: key(), _type: 'day', date: '2026-11-22', sessions: [
      {_key: key(), _type: 'session', time: '10:00', title: 'Editing a trip report', speaker: ref('author-ada'), room: 'Main hall'},
      {_key: key(), _type: 'session', time: '13:30', title: 'Group walk to the Lac Blanc trailhead', speaker: ref('author-lin'), room: 'Outside'},
    ]},
  ],
  tickets: [
    {_key: key(), _type: 'ticket', name: 'Weekend pass', price: 85, soldOut: false},
    {_key: key(), _type: 'ticket', name: 'Saturday only', price: 50, soldOut: true},
    {_key: key(), _type: 'ticket', name: 'Livestream', price: 0, soldOut: false},
  ],
  gearList: [keyedRef('product-shell'), keyedRef('product-notebook'), keyedRef('product-mug')],
  details: [p('Doors open at **08:45**. The group walk on Sunday needs boots and a [Featherlight Shell](@product-shell) or similar.')],
})
add({
  _id: 'event-boathouse-talk',
  _type: 'event',
  title: 'Paddling the Torne: an evening talk',
  slug: slug('paddling-the-torne'),
  format: 'in-person',
  startsAt: '2026-09-12T18:00:00Z',
  endsAt: '2026-09-12T20:00:00Z',
  venue: ref('venue-boathouse'),
  cover: figure('canoe', 'A canoe on a still river'),
  summary: 'Mateo on two weeks down the Torne river by canoe, with photos.',
  speakers: [keyedRef('author-mateo')],
  tickets: [{_key: key(), _type: 'ticket', name: 'Entry', price: 10, soldOut: true}],
  details: [p('A past event, kept for the archive.')],
})

/* pages */
add({
  _id: 'page-home',
  _type: 'page',
  title: 'Home',
  slug: slug('home'),
  sections: [
    {_key: key(), _type: 'hero', eyebrow: 'Autumn 2026', heading: 'Routes worth the early start', subheading: 'Trip reports, field craft and gear we actually carry — from people who walk for a living.', image: figure('peaks', 'Mountain peaks at first light'), actions: [{_key: key(), ...link('Read the Haute Route report', 'article-haute-route')}, {_key: key(), ...link('Shop the kit', 'category-gear')}], layout: 'split', background: color('#f5f1ea')},
    {_key: key(), _type: 'statsBand', stats: [{_key: key(), _type: 'stat', value: 1240, unit: ' km', label: 'walked this season'}, {_key: key(), _type: 'stat', value: 38, label: 'huts reviewed'}, {_key: key(), _type: 'stat', value: 4, label: 'boots retired'}]},
    {_key: key(), _type: 'featuredContent', heading: 'This month', items: [keyedRef('article-haute-route'), keyedRef('product-ridgeline'), keyedRef('event-winter-traverse'), keyedRef('article-coast')]},
    {_key: key(), _type: 'featureGrid', heading: 'What we do', columns: 3, features: [
      {_key: key(), _type: 'feature', icon: '🧭', title: 'Routes', body: 'Stage-by-stage reports with real numbers, not brochure copy.', link: link('Trails', 'category-trails')},
      {_key: key(), _type: 'feature', icon: '🎒', title: 'Gear', body: 'Long-term tests. We publish what broke.', link: link('Gear', 'category-gear')},
      {_key: key(), _type: 'feature', icon: '🌨️', title: 'Events', body: 'Talks and weekends with the people who write here.', link: link('Events', 'event-winter-traverse')},
    ]},
    {_key: key(), _type: 'gallery', heading: 'From the field', layout: 'grid', images: [keyedFigure('valley', 'A green valley'), keyedFigure('lake', 'A mountain lake'), keyedFigure('waterfall', 'A waterfall in a gorge'), keyedFigure('forest', 'A mossy forest'), keyedFigure('coast', 'A sea cliff'), keyedFigure('canoe', 'A canoe at rest')]},
    {_key: key(), _type: 'testimonials', quotes: [
      {_key: key(), _type: 'quote', text: 'The only gear reviews I trust, because they tell me what failed.', name: 'A reader in Bergen', rating: 5},
      {_key: key(), _type: 'quote', text: 'I edit these, and I still learn something every issue.', author: ref('author-ada', {_weak: true}), rating: 4},
    ]},
    {_key: key(), _type: 'callToAction', heading: 'Join us for the Winter Traverse', body: 'Two days in Chamonix, or online. Tickets from free.', action: link('See the programme', 'event-winter-traverse'), accent: color('#6a3fd4')},
  ],
  seo: {_type: 'seo', title: 'Meridian — routes worth the early start', description: 'Trip reports, field craft and gear from people who walk for a living.'},
})
add({
  _id: 'page-about',
  _type: 'page',
  title: 'About',
  slug: slug('about'),
  sections: [
    {_key: key(), _type: 'hero', eyebrow: 'About', heading: 'A small magazine about long walks', subheading: 'Four people, one shared spreadsheet of huts, and a lot of maps.', layout: 'text'},
    {_key: key(), _type: 'textSection', heading: 'Who we are', body: [p('Meridian started as a newsletter between four friends who guide, photograph and write about the mountains. It is now a magazine, a small shop and a couple of events a year.'), p('We are independent. We buy the gear we review, and we [say so](@page-about) when we don\'t.')]},
    {_key: key(), _type: 'mapSection', heading: 'Where to find us', places: [keyedRef('venue-basecamp'), keyedRef('venue-boathouse')]},
    {_key: key(), _type: 'faq', heading: 'Questions', groups: [
      {_key: key(), _type: 'faqGroup', title: 'The magazine', items: [
        {_key: key(), _type: 'faqItem', question: 'Can I pitch a story?', answer: [p('Yes. Send a paragraph and a photo to **pitches@meridian.example**.')]},
        {_key: key(), _type: 'faqItem', question: 'Do you take advertising?', answer: [p('No. The shop pays for the magazine.')]},
      ]},
      {_key: key(), _type: 'faqGroup', title: 'The shop', items: [
        {_key: key(), _type: 'faqItem', question: 'Where do you ship?', answer: [p('Across Europe. Returns within 60 days, *worn or not*.')]},
      ]},
    ]},
  ],
})

/* singletons and the announcement */
add({_id: 'settings', _type: 'settings', title: 'Meridian', tagline: locale('Routes worth the early start', 'Rutas que merecen madrugar', 'Des itinéraires qui valent le réveil'), homepage: ref('page-home'), contactEmail: 'hello@meridian.example', brandColor: color('#6a3fd4'), footerNote: [p('Meridian is a demo for **sanity-sim**. Photos from [Unsplash](https://unsplash.com) via Picsum.')], social: [{_key: key(), _type: 'socialLink', network: 'Instagram', url: 'https://instagram.com/meridian.example'}, {_key: key(), _type: 'socialLink', network: 'Mastodon', url: 'https://mastodon.social/@meridian'}], seo: {_type: 'seo', title: 'Meridian', description: 'Trip reports, field craft and gear.'}})
add({
  _id: 'navigation',
  _type: 'navigation',
  title: 'Main navigation',
  items: [
    {_key: key(), _type: 'menuItem', link: link('Articles', 'category-trails'), children: [
      {_key: key(), _type: 'menuItem', link: link('Trails', 'category-trails'), children: [
        {_key: key(), _type: 'menuItem', link: link('Alpine', 'category-alpine')},
        {_key: key(), _type: 'menuItem', link: link('Coastal', 'category-coastal')},
      ]},
      {_key: key(), _type: 'menuItem', link: link('Field craft', 'category-field-craft')},
    ]},
    {_key: key(), _type: 'menuItem', link: link('Shop', 'category-gear'), children: [
      {_key: key(), _type: 'menuItem', link: link('Ridgeline 32L', 'product-ridgeline')},
      {_key: key(), _type: 'menuItem', link: link('Featherlight Shell', 'product-shell')},
    ]},
    {_key: key(), _type: 'menuItem', link: link('Events', 'event-winter-traverse')},
    {_key: key(), _type: 'menuItem', link: link('About', 'page-about')},
    {_key: key(), _type: 'menuItem', link: link('Newsletter', 'mailto:hello@meridian.example')},
  ],
})
add({_id: 'announcement-autumn', _type: 'announcement', enabled: true, message: 'Winter Traverse tickets are on sale — livestream passes are free.', link: link('Get a ticket', 'event-winter-traverse'), startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-11-21T09:00:00Z'})

/* ------------------------------------------------------------------ write */

fs.writeFileSync(path.join(root, 'data.ndjson'), documents.map((doc) => JSON.stringify(doc)).join('\n') + '\n')
execFileSync('tar', ['--format=ustar', '-czf', OUT, '-C', work, 'meridian'])
fs.rmSync(work, {recursive: true, force: true})
console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${documents.length} documents, ${images.size} images, ${files.size} files (${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB)`)
