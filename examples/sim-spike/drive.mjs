// Phase 0 driver (docs/plans/evidence/sanity-sim-phase-0/request-inventory.md):
// drives a stock Studio 6.20 against the Mode 2 origin and records every API request.
// Usage: node drive.mjs <outDir> [studioUrl] [apiPort]
import {createRequire} from 'node:module'
import fs from 'node:fs'
const require = createRequire(new URL('../../package.json', import.meta.url))
const {chromium} = require('@playwright/test')

const OUT = process.argv[2]
const STUDIO = process.argv[3] ?? 'http://localhost:3336'
const API_PORT = process.argv[4] ?? '3991'
fs.mkdirSync(OUT, {recursive: true})

const browser = await chromium.launch()
const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 1400, height: 900}})
const page = await context.newPage()
const cdp = await context.newCDPSession(page)
await cdp.send('Network.enable')

let step = 'boot'
const records = new Map()
const consoleErrors = []
cdp.on('Network.requestWillBeSent', (e) => {
  if (!e.request.url.includes(`:${API_PORT}`)) return
  records.set(e.requestId, {step, method: e.request.method, url: e.request.url, body: e.request.postData?.slice(0, 2000)})
})
cdp.on('Network.responseReceived', (e) => {
  const r = records.get(e.requestId)
  if (r) Object.assign(r, {status: e.response.status, protocol: e.response.protocol})
})
cdp.on('Network.loadingFailed', (e) => {
  const r = records.get(e.requestId)
  if (r) r.failed = e.errorText
})
cdp.on('Network.webSocketCreated', (e) => {
  if (e.url.includes(`:${API_PORT}`)) records.set(`ws-${e.requestId}`, {step, method: 'WS', url: e.url})
})
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push({step, type: m.type(), text: m.text().slice(0, 400)})
})

const results = []
async function run(name, fn) {
  step = name
  const started = Date.now()
  try {
    await fn()
    results.push({step: name, ok: true, ms: Date.now() - started})
  } catch (error) {
    results.push({step: name, ok: false, ms: Date.now() - started, error: String(error.message).split('\n')[0]})
  }
  await page.waitForTimeout(1500)
  await page.screenshot({path: `${OUT}/${name}.png`})
}

await run('boot', async () => {
  await page.goto(`${STUDIO}/structure`)
  await page.getByRole('link', {name: /Article/}).first().waitFor({timeout: 30000})
})

await run('open-list', async () => {
  await page.getByRole('link', {name: /Article/}).first().click()
  await page.getByText('Born with no Sanity project').first().waitFor({timeout: 15000})
})

await run('open-document', async () => {
  await page.getByText('Born with no Sanity project').first().click()
  await page.locator('[data-testid="field-title"] input').waitFor({timeout: 20000})
})

await run('edit-title', async () => {
  const input = page.locator('[data-testid="field-title"] input')
  await input.click()
  await input.press('End')
  await input.pressSequentially(' (edited)', {delay: 30})
  await page.waitForTimeout(3000)
})

await run('create-author', async () => {
  await page.goto(`${STUDIO}/intent/create/template=author;type=author/`)
  const name = page.locator('[data-testid="field-name"] input')
  await name.waitFor({timeout: 20000})
  await name.pressSequentially('Phase Zero', {delay: 30})
  await page.waitForTimeout(3000)
})

await run('upload-image', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64')
  await page.locator('input[type="file"]').first().setInputFiles({name: 'tiny.png', mimeType: 'image/png', buffer: png}, {timeout: 10000})
  await page.waitForTimeout(5000)
})

await run('publish', async () => {
  await page.locator('[data-testid="action-publish"]').click({timeout: 15000})
  await page.waitForTimeout(5000)
})

await run('history', async () => {
  await page.locator('[data-testid="pane-footer-document-status"], [data-testid="review-changes-button"]').first().click({timeout: 8000})
  await page.waitForTimeout(4000)
})

await run('releases', async () => {
  await page.goto(`${STUDIO}/releases`)
  await page.waitForTimeout(5000)
})

await run('create-release', async () => {
  await page.getByRole('button', {name: /new release|create release/i}).first().click({timeout: 8000})
  await page.waitForTimeout(1500)
  await page.keyboard.type('Phase 0 release')
  await page.getByRole('button', {name: /^create release$/i}).last().click({timeout: 8000})
  await page.waitForTimeout(5000)
})

await run('vision', async () => {
  await page.goto(`${STUDIO}/vision`)
  await page.waitForTimeout(4000)
  await page.keyboard.press('Control+Enter')
  await page.waitForTimeout(3000)
})

await run('search', async () => {
  await page.goto(`${STUDIO}/structure`)
  await page.waitForTimeout(3000)
  await page.keyboard.press('Meta+k')
  await page.waitForTimeout(1000)
  await page.keyboard.type('Born', {delay: 50})
  await page.waitForTimeout(4000)
})

// Peak concurrency of open listen streams (no loadingFinished, no failure).
const all = [...records.values()]
fs.writeFileSync(`${OUT}/requests.json`, JSON.stringify(all, null, 2))
fs.writeFileSync(`${OUT}/console.json`, JSON.stringify(consoleErrors, null, 2))
fs.writeFileSync(`${OUT}/steps.json`, JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
console.log('requests:', all.length, 'protocols:', [...new Set(all.map((r) => r.protocol))])
await browser.close()
