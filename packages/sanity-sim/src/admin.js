/* Placeholder until the dashboard API lands (Phase 3). */
import {notImplemented} from './errors.js'

export async function handleAdmin(context, req, res, url) {
  throw notImplemented(`${req.method} ${url.pathname}`)
}
