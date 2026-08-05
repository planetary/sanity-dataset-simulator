/**
 * The stand-in "staging" dataset.
 *
 * `base-dataset.ndjson` is a committed, read-only snapshot that plays the part
 * of the hosted base dataset. Two things follow from that, and both are the
 * point of the example:
 *
 *   1. the loop runs with no network, no project ID and no token;
 *   2. "staging is untouched" is checkable with `git status` — nothing in this
 *      repository writes to this file, and the read path
 *      (`createDocumentBaseSource`) has no write method to call.
 *
 * Pointing the site at a real dataset instead is a one-line swap for
 * `createHttpBaseSource`, which issues GET requests only. See the README.
 */
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import type {QueryDocument} from '../../../packages/sanity-overlay-query/src/index'

/** Absolute path of the committed example dataset. */
export const SITE_BASE_DATASET_PATH = fileURLToPath(
  new URL('../base-dataset.ndjson', import.meta.url),
)

/** Parse an NDJSON dataset export — the shape `sanity dataset export` produces. */
export function loadNdjsonDataset(path: string = SITE_BASE_DATASET_PATH): QueryDocument[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const document = JSON.parse(line) as QueryDocument
      if (typeof document._id !== 'string' || typeof document._type !== 'string') {
        throw new Error(`${path}:${index + 1} is not a Sanity document (needs _id and _type)`)
      }
      return document
    })
}
