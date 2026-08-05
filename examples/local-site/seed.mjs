// Write a demo overlay, so the loop can be seen without opening Studio.
//
//   pnpm --filter local-site seed
//   node --experimental-strip-types examples/local-site/seed.mjs --root=<dir>
//
// It edits one article's title, creates a branch-only article and deletes
// another — the three cases a base-only read gets wrong. Every write goes
// through the real mutation engine and the real `FsOverlayStore`, so the result
// on disk is what a Studio session would have produced.
//
// Running it twice is safe: each run commits its own transactions and the last
// write wins.
import {register} from 'node:module'
import {fileURLToPath} from 'node:url'
import process from 'node:process'

register('./tsExtensionHook.mjs', import.meta.url)

const KNOWN = ['root', 'dataset']

function parseFlags(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    /* `pnpm run <script> -- --root=…` forwards the bare `--` verbatim. */
    if (token === '--') continue
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(token)}`)
    const [name, inline] = token.slice(2).split('=')
    if (!KNOWN.includes(name)) throw new Error(`unknown flag --${name} (known: ${KNOWN.join(', ')})`)
    const value = inline ?? argv[++index]
    if (value === undefined) throw new Error(`--${name} needs a value`)
    flags[name] = value
  }
  return flags
}

const flags = parseFlags(process.argv.slice(2))

// A SEPARATE root from the one `run.mjs` defaults to. The kitchen-sink overlay
// is whatever the running Studio has put there; seeding into it would overwrite
// a live editing session's work. `--root=../kitchen-sink` if that is what you
// actually want.
const DEMO_OVERLAY_ROOT = fileURLToPath(new URL('./.overlay-demo/', import.meta.url))
const root = flags.root ?? process.env.SANITY_OVERLAY_ROOT ?? DEMO_OVERLAY_ROOT

const {seedOverlay} = await import('../../packages/sanity-overlay-client/src/index.ts')
const {loadNdjsonDataset, SITE_BASE_DATASET_PATH} = await import('./src/dataset.ts')

const baseDocuments = loadNdjsonDataset(flags.dataset ?? SITE_BASE_DATASET_PATH)

const result = await seedOverlay({
  root,
  baseDocuments,
  edits: [
    {
      kind: 'edit',
      id: 'article-01',
      operations: [{type: 'set', path: ['title'], value: 'Edited on the branch ✅'}],
    },
    {
      // `createOrReplace`, not `create`: this script is meant to be re-runnable,
      // and `create` is strict about duplicates by design (PRD §35.4).
      kind: 'createOrReplace',
      document: {
        _id: 'drafts.article-branch-demo',
        _type: 'article',
        title: 'Created on the branch',
        slug: {_type: 'slug', current: 'created-on-the-branch'},
        author: {_type: 'reference', _ref: 'author-2'},
      },
    },
    {kind: 'delete', id: 'article-02'},
  ],
})

console.log(`[seed] overlay   ${result.overlayId}`)
console.log(`[seed] root      ${root}/.sanity-overlay`)
console.log(`[seed] revision  ${result.revision}`)
console.log(`[seed] touched   ${result.affectedDocumentIds.join(', ')}`)
console.log('[seed] now reload the site: article-01 is retitled, article-02 is gone,')
console.log('[seed] and /articles/created-on-the-branch exists.')
