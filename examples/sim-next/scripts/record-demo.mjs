#!/usr/bin/env node
/**
 * Records a captioned tour of sanity-sim with the Meridian demo, as a video.
 * Start the demo first (it must be on the default ports 3939 and 3000):
 *
 *   node ../../packages/sanity-sim/bin/sanity-sim.js --seed seed.tar.gz
 *   node scripts/record-demo.mjs [out.webm]
 *
 * It drives one recorded browser through the dashboard, the site, the Studio,
 * Presentation, a dataset hot swap, Media Library and Vision, and puts the
 * demo's data back the way it found it afterwards. A second, unrecorded
 * browser keeps the site open throughout, standing in for a visitor whose
 * <SanityLive> revalidates the published pages when content changes.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from '@playwright/test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, '..', 'demo.webm'))
const UPLOAD = process.env.DEMO_UPLOAD ?? path.join(HERE, '..', '..', '..', 'packages', 'sanity-sim', 'dashboard', 'icon.svg')
const SITE = 'http://localhost:3000'
const DASH = 'http://localhost:3939'
const API = 'http://127.0.0.1:3939/v2025-02-19'
const API_HEADERS = {host: 'b1n03q3z.localhost', 'content-type': 'application/json'}
const SIZE = {width: 1440, height: 900}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const api = async (pathname, body) => {
  const response = await fetch(`${API}${pathname}`, body ? {method: 'POST', headers: API_HEADERS, body: JSON.stringify(body)} : {headers: API_HEADERS})
  if (!response.ok) throw new Error(`${pathname}: ${response.status} ${await response.text()}`)
  return response.json()
}
const getDoc = async (id) => (await api(`/data/doc/production/${id}`)).documents[0]

/* ---------------------------------------------------------------- overlay: captions and a cursor */

const OVERLAY = () => {
  const STYLE = `
    #demo-cursor { position: fixed; z-index: 2147483647; width: 22px; height: 22px; margin: -4px 0 0 -4px; pointer-events: none;
      transition: left 0.5s cubic-bezier(.3,.7,.2,1), top 0.5s cubic-bezier(.3,.7,.2,1), transform 0.12s; left: -50px; top: -50px; }
    #demo-cursor.down { transform: scale(0.8); }
    #demo-caption { position: fixed; z-index: 2147483646; left: 50%; bottom: 28px; transform: translateX(-50%); max-width: 1100px; pointer-events: none;
      padding: 14px 22px; border-radius: 14px; background: rgba(22, 16, 40, 0.88); color: #fff; font: 500 19px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif;
      box-shadow: 0 10px 30px rgba(0,0,0,.25); opacity: 0; transition: opacity .35s; }
    #demo-caption.on { opacity: 1; }
    #demo-caption b { display: block; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: #c4b3ff; margin-bottom: 2px; }
    nextjs-portal { display: none !important; }`
  const install = () => {
    if (!document.body) return
    /* Next's dev badge lives in a shadow root that a page stylesheet can't always reach. */
    for (const portal of document.querySelectorAll('nextjs-portal')) if (portal.style.display !== 'none') portal.style.display = 'none'
    /* React owns <head> in Next and Studio and can drop what is added there, so everything lives in <body>. */
    if (!document.getElementById('demo-style')) {
      const style = document.createElement('style')
      style.id = 'demo-style'
      style.textContent = STYLE
      document.body.append(style)
    }
    if (document.getElementById('demo-cursor')) return
    const cursor = document.createElement('div')
    cursor.id = 'demo-cursor'
    cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l16 9.5-7 1.6-3.6 6.9z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>'
    const caption = document.createElement('div')
    caption.id = 'demo-caption'
    document.body.append(cursor, caption)
    const saved = sessionStorage.getItem('demo-caption')
    if (saved) {
      caption.innerHTML = saved
      caption.classList.add('on')
    }
    const pos = sessionStorage.getItem('demo-cursor')
    if (pos) {
      const [x, y] = pos.split(',')
      cursor.style.transition = 'none'
      cursor.style.left = `${x}px`
      cursor.style.top = `${y}px`
      requestAnimationFrame(() => (cursor.style.transition = ''))
    }
  }
  if (window.top !== window) return
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', install) : install()
  new MutationObserver(install).observe(document.documentElement, {childList: true, subtree: true})
}

async function caption(page, title, text, hold = 0) {
  const html = `<b>${title}</b>${text}`
  await page.evaluate((value) => {
    sessionStorage.setItem('demo-caption', value)
    const el = document.getElementById('demo-caption')
    if (!el) return
    el.classList.remove('on')
    setTimeout(() => {
      el.innerHTML = value
      el.classList.add('on')
    }, 200)
  }, html)
  await sleep(hold || 600 + text.length * 38)
}

async function moveTo(page, x, y) {
  await page.evaluate(([x, y]) => {
    sessionStorage.setItem('demo-cursor', `${x},${y}`)
    const el = document.getElementById('demo-cursor')
    if (el) {
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }
  }, [x, y])
  await page.mouse.move(x, y, {steps: 12})
  await sleep(550)
}

async function pointAt(page, locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => {})
  const box = await locator.boundingBox()
  if (!box) throw new Error(`nothing to point at: ${locator}`)
  await moveTo(page, box.x + box.width / 2, box.y + box.height / 2)
  return box
}

async function click(page, locator, {pause = 700} = {}) {
  await locator.waitFor({state: 'visible', timeout: 30_000})
  await pointAt(page, locator)
  await page.evaluate(() => document.getElementById('demo-cursor')?.classList.add('down'))
  await page.mouse.down()
  await sleep(90)
  await page.mouse.up()
  await page.evaluate(() => document.getElementById('demo-cursor')?.classList.remove('down'))
  await sleep(pause)
}

async function scrollBy(page, total, {steps = 10, delay = 140} = {}) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, total / steps)
    await sleep(delay)
  }
}

async function card(page, title, subtitle, hold = 3500) {
  await page.setContent(`<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 30% 20%,#8257ec,#2b1460);font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#fff">
    <div style="text-align:center">
      <img src="data:image/svg+xml;base64,${fs.readFileSync(path.join(HERE, '..', '..', '..', 'packages', 'sanity-sim', 'dashboard', 'icon.svg')).toString('base64')}" width="96" height="96" style="border-radius:22px;box-shadow:0 20px 50px rgba(0,0,0,.35)">
      <h1 style="font-size:64px;margin:28px 0 8px;letter-spacing:-.02em">${title}</h1>
      <p style="font-size:24px;opacity:.85;margin:0;max-width:900px">${subtitle}</p>
    </div></body></html>`)
  await sleep(hold)
}

/* ---------------------------------------------------------------- the tour */

async function tour(page) {
  await card(page, 'sanity-sim', 'A local Sanity Content Lake: your Studio and your app, running entirely on your machine.', 4500)
  await card(page, '<code style="font-size:52px;background:rgba(255,255,255,.12);padding:6px 18px;border-radius:12px">npx sanity-sim</code>', 'One command detects the Studio and app, wires them to the simulator, seeds the data and runs your dev server.', 5000)

  /* Dashboard */
  await page.goto(`${DASH}/#/documents`)
  await page.waitForLoadState('networkidle').catch(() => {})
  await caption(page, 'The dashboard', 'Everything in the simulated Content Lake, at the server root. These are the demo\'s 50-odd documents.')
  await click(page, page.getByText('article', {exact: true}).first())
  await click(page, page.getByText('Crossing the Haute Route in autumn').first(), {pause: 1500})
  await caption(page, 'Documents', 'Open any document to read or edit its JSON, browse its history, or restore an earlier revision.')
  await click(page, page.getByRole('link', {name: /^Query/}))
  await caption(page, 'Query', 'Run GROQ against any perspective: published, drafts, raw, or a content release.')
  const groq = page.getByLabel('GROQ query')
  await click(page, groq)
  await page.keyboard.press('Meta+A')
  await groq.pressSequentially('*[_type == "product"]{title, price, "variants": count(variants)}', {delay: 28})
  await click(page, page.getByLabel('Parameters (JSON)'))
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Backspace')
  await click(page, page.getByRole('button', {name: 'Run', exact: true}), {pause: 2500})
  await click(page, page.getByRole('link', {name: /^Activity/}), {pause: 1200})
  await caption(page, 'Activity', 'Every change to the data as it happens: who wrote what, and when.')
  await click(page, page.getByRole('link', {name: /^Datasets/}), {pause: 1200})
  await caption(page, 'Datasets', 'Several datasets side by side. We\'ll come back here to hot-swap one under a running site.')

  /* Site */
  await page.goto(SITE)
  await caption(page, 'The demo site', 'Meridian: a Next.js 16 site reading everything through next-sanity, from the simulator instead of Sanity.')
  await scrollBy(page, 900)
  await caption(page, 'Page builder', 'Sections, references and images from a page-builder array: featured content mixes articles, products and events.')
  await scrollBy(page, 1300)
  await sleep(800)
  await page.goto(`${SITE}/articles/crossing-the-haute-route`)
  await caption(page, 'Rich text', 'Portable Text with headings, lists, links, footnotes, inline product mentions, figures, callouts, tables, code and video.')
  await scrollBy(page, 1600, {steps: 14})
  await scrollBy(page, 1400, {steps: 12})
  await page.goto(`${SITE}/products/ridgeline-32l-pack`)
  await caption(page, 'Products', 'Variants with colours and stock, a spec table, a PDF manual, and products this one is on the kit list for.')
  await scrollBy(page, 600)
  await page.goto(`${SITE}/events/winter-traverse-weekend`)
  await caption(page, 'Events', 'Nested arrays (days → sessions), references to speakers and gear, and a venue with a geopoint.')
  await scrollBy(page, 700)

  /* Studio */
  await page.goto(`${SITE}/studio/structure`)
  await page.getByText('Site settings').first().waitFor({timeout: 90_000})
  await caption(page, 'Sanity Studio', 'Stock Studio 6.20, embedded in the Next app, with a custom desk structure. Every request goes to the simulator.')
  await click(page, page.getByRole('link', {name: 'Articles'}).first())
  await click(page, page.getByRole('link', {name: 'By category'}).first())
  await click(page, page.getByRole('link', {name: /Trails/}).first(), {pause: 1500})
  await click(page, page.getByText('Crossing the Haute Route in autumn').last(), {pause: 2500})
  await caption(page, 'Every field type', 'References, arrays, objects, geopoints, files, colours, tables, code, localized strings — validation included.')
  await click(page, page.getByRole('tab', {name: 'Details'}).first(), {pause: 1200})
  await scrollBy(page, 900, {steps: 12})
  await sleep(1200)

  /* Releases */
  await page.goto(`${SITE}/studio/releases`)
  await page.getByText('Autumn issue').first().waitFor({timeout: 60_000})
  await caption(page, 'Content releases', 'Releases, scheduling and versions are simulated too. The "Autumn issue" is scheduled with a new article in it.')
  await click(page, page.getByText('Autumn issue').first(), {pause: 2500})

  /* Presentation */
  await page.goto(`${SITE}/studio/presentation`)
  const preview = page.frameLocator('iframe')
  const heading = preview.getByRole('heading', {name: 'Routes worth the early start'})
  await heading.waitFor({timeout: 90_000})
  await page.waitForFunction(() => getComputedStyle(document.querySelector('iframe')).opacity === '1', null, {timeout: 60_000})
  await caption(page, 'Presentation', 'Draft mode and visual editing against the simulator: the preview shows drafts, and everything is clickable.')
  await pointAt(page, heading)
  await sleep(900)
  await click(page, heading, {pause: 1800})
  await caption(page, 'Live draft edits', 'Click to edit, type, and the preview updates as you type — through the simulator\'s live listener.')
  await page.keyboard.press('Meta+A')
  await page.keyboard.type('Routes worth the 5 a.m. alarm', {delay: 70})
  await preview.getByRole('heading', {name: 'Routes worth the 5 a.m. alarm'}).waitFor({timeout: 30_000})
  await sleep(1500)
  await caption(page, 'Publish', 'Publishing goes through the Actions API, exactly as it would against Sanity.')
  await click(page, page.getByRole('button', {name: 'Publish'}).last(), {pause: 3000})

  await page.goto(SITE)
  await caption(page, 'Live on the site', 'The published change is on the site: next-sanity\'s Live Content API revalidated the cached page.')
  await sleep(1500)
  await caption(page, 'And without a reload', 'Now an editor changes the announcement elsewhere. Watch the bar at the top.')
  await sleep(1500)
  await api('/data/mutate/production', {mutations: [{patch: {id: 'announcement-autumn', set: {message: 'Just in: two more workshop places for the Winter Traverse.'}}}]})
  await page.getByText('Just in: two more workshop places').waitFor({timeout: 20_000})
  await sleep(3000)

  /* Hot swap */
  await page.goto(`${DASH}/#/datasets`)
  await caption(page, 'Hot-swap a dataset', 'Link "production" to another stored dataset, while the site and Studio keep running.')
  const linkName = page.getByLabel('Name to link')
  await click(page, linkName)
  await linkName.pressSequentially('production', {delay: 60})
  const target = page.getByLabel('Dataset to link to')
  await pointAt(page, target)
  await target.selectOption('winter-preview')
  await sleep(600)
  await click(page, page.getByRole('button', {name: 'Link', exact: true}), {pause: 1500})
  await page.goto(SITE)
  await page.getByText('First snow on the high routes').waitFor({timeout: 20_000})
  await caption(page, 'Swapped', 'The same site, now reading the winter-preview dataset. No config change, no restart.')
  await sleep(2500)
  await page.goto(`${DASH}/#/datasets`)
  page.once('dialog', (dialog) => dialog.accept())
  await caption(page, 'And back', 'Unlinking puts production\'s own documents back.')
  await click(page, page.getByRole('button', {name: 'Unlink'}).first(), {pause: 1500})

  /* Media Library */
  await page.goto(`${SITE}/studio/structure/siteSettings`)
  await page.getByRole('tab', {name: 'Brand'}).first().waitFor({timeout: 60_000})
  await caption(page, 'Media Library', 'Studio\'s Media Library works locally: the simulator serves a picker in place of media.sanity.io.')
  await click(page, page.getByRole('tab', {name: 'Brand'}).first())
  await click(page, page.getByRole('button', {name: 'Select', exact: true}).first())
  await click(page, page.getByRole('menuitem', {name: 'Media Library'}).first(), {pause: 2500})
  const picker = page.frameLocator('iframe[src*="_sim/media-library"]')
  await picker.getByText('Upload').first().waitFor({timeout: 30_000})
  await caption(page, 'Upload and pick', 'Upload into the library, pick the asset, and Studio links it into the dataset like the real service does.')
  await pointAt(page, picker.getByText('Upload').first())
  await picker.locator('input[type="file"]').setInputFiles(UPLOAD)
  await sleep(2500)
  await click(page, page.getByRole('button', {name: 'Select', exact: true}).last(), {pause: 1500})
  await page.getByRole('tab', {name: 'Brand'}).first().waitFor()
  await caption(page, 'Linked', 'The logo field now holds the library asset: an asset reference plus a link back to Media Library.', 4000)

  /* Vision */
  await page.goto(`${SITE}/studio/vision`)
  await page.locator('.cm-content').first().waitFor({timeout: 60_000})
  await caption(page, 'Vision', 'And GROQ in Studio\'s own Vision tool, with semantic search approximated locally.')
  await click(page, page.locator('.cm-content').first())
  await page.keyboard.press('Meta+A')
  await page.keyboard.type('*[_type == "article"] | score(text::semanticSimilarity("alpine huts in autumn")) | order(_score desc)[0...3]{title, _score}', {delay: 18})
  await page.keyboard.press('Control+Enter')
  await sleep(4000)

  await card(page, 'sanity-sim', 'Studio, Presentation, Live, releases, Media Library and GROQ — all local. <br><span style="opacity:.75;font-size:20px">packages/sanity-sim · examples/sim-next</span>', 5000)
}

/* ---------------------------------------------------------------- run */

const before = {
  home: await getDoc('page-home'),
  announcement: await getDoc('announcement-autumn'),
  settings: await getDoc('settings'),
}
const restore = async () => {
  const strip = ({_rev, _createdAt, _updatedAt, ...doc}) => doc
  await fetch(`${DASH}/_sim/links/production`, {method: 'DELETE'}).catch(() => {})
  await api('/data/mutate/production', {
    mutations: [{createOrReplace: strip(before.home)}, {createOrReplace: strip(before.announcement)}, {createOrReplace: strip(before.settings)}, {delete: {id: 'drafts.page-home'}}, {delete: {id: 'drafts.settings'}}],
  })
}

/* The hot-swap scene links production to "winter-preview": a copy of production with a winter hero. */
const winter = await api(`/data/query/winter-preview?query=${encodeURIComponent('count(*)')}`)
if (winter.result === 0) {
  const docs = (await (await fetch(`${API}/data/export/production`, {headers: API_HEADERS})).text()).trim().split('\n').map((line) => JSON.parse(line))
  const copies = docs.filter((doc) => !doc._id.startsWith('_.')).map(({_rev, _createdAt, _updatedAt, ...doc}) => {
    if (doc._id === 'page-home') {
      const hero = doc.sections.find((section) => section._type === 'hero')
      Object.assign(hero, {eyebrow: 'Winter 2026 · preview', heading: 'First snow on the high routes', subheading: 'The winter issue: ski-touring lines, hut-to-hut in the cold, and the kit that survived January.'})
      const snow = docs.find((asset) => asset.originalFilename === 'snow-forest.jpg')
      if (snow) hero.image.asset._ref = snow._id
      const stats = doc.sections.find((section) => section._type === 'statsBand')
      Object.assign(stats.stats[0], {value: 312, label: 'km on skis so far'})
    }
    if (doc._id === 'announcement-autumn') doc.message = 'Winter preview: this is the winter-preview dataset, linked as production.'
    return doc
  })
  await api('/data/mutate/winter-preview', {mutations: copies.map((doc) => ({createOrReplace: doc}))})
}

/* Presentation leaves preview-URL secrets behind; they clutter the dashboard's first screen. */
const secrets = (await api(`/data/query/production?perspective=raw&query=${encodeURIComponent('*[_type == "sanity.previewUrlSecret"]._id')}`)).result
if (secrets.length) await api('/data/mutate/production', {mutations: secrets.map((id) => ({delete: {id}}))})

const browser = await chromium.launch()
/* The unrecorded visitor: keeps a published page open so <SanityLive> revalidates the cache. */
const visitorContext = await browser.newContext({ignoreHTTPSErrors: true})
const visitor = await visitorContext.newPage()
await visitor.goto(SITE)
/* Warm the Studio bundle so the recording doesn't sit on Next's first compile. */
const warm = await visitorContext.newPage()
await warm.goto(`${SITE}/studio/structure`, {timeout: 120_000})
await warm.getByText('Site settings').first().waitFor({timeout: 120_000})
await warm.close()

const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanity-sim-demo-'))
const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: SIZE, recordVideo: {dir: videoDir, size: SIZE}})
await context.addInitScript(OVERLAY)
const page = await context.newPage()
try {
  await tour(page)
} catch (error) {
  await page.screenshot({path: OUT.replace(/\.\w+$/, '-failure.png')}).catch(() => {})
  throw error
} finally {
  const video = page.video()
  await context.close()
  /* Restore while the visitor's <SanityLive> is still connected, so the site's cache refreshes too. */
  await restore().catch((error) => console.error('restore failed:', error.message))
  await sleep(4000)
  await visitorContext.close()
  await browser.close()
  if (video) fs.renameSync(await video.path(), OUT)
}
console.log(`wrote ${OUT}`)
