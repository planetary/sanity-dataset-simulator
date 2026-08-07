/**
 * Hosted Sanity Query API access via fetch — no client dependency.
 * Used by the empty-overlay parity oracle (testing-strategy §2):
 * hosted result vs pinned groq-js over the same fixture must be equal.
 */
import {loadExplicitEnv} from './env'
import type {ExplicitEnv} from './env'

export interface HostedConfig {
  projectId: string
  dataset: string
  apiVersion: string
  token: string
}

/**
 * Hosted access, or `null` — and `null` means the caller SKIPS.
 *
 * The `env` argument is the whole point. This used to destructure `process.env`,
 * which meant a `SANITY_PROJECT_ID` exported in someone's shell for an unrelated
 * repository silently pointed this oracle at that project. It now reads a record
 * the caller resolved explicitly — `loadExplicitEnv()` by default, which reads
 * the repo-root `.env` and nothing else — so an ambient value cannot reach here
 * at all, whether or not a caller remembers to pass one.
 *
 * @see ./env.ts for the loader's contract and the ambient-vs-explicit ruling.
 */
export function hostedConfigFromEnv(env: ExplicitEnv = loadExplicitEnv()): HostedConfig | null {
  const projectId = env.SANITY_PROJECT_ID
  const dataset = env.SANITY_BASE_DATASET
  const token = env.SANITY_API_READ_TOKEN
  if (!projectId || !dataset || !token) return null
  return {
    projectId,
    dataset,
    apiVersion: env.SANITY_API_VERSION || 'v2025-02-19',
    token,
  }
}

export async function hostedQuery<T = unknown>(
  cfg: HostedConfig,
  query: string,
  params: Record<string, unknown> = {},
  perspective: 'published' | 'drafts' = 'published',
): Promise<T> {
  const url = new URL(`https://${cfg.projectId}.api.sanity.io/${cfg.apiVersion}/data/query/${cfg.dataset}`)
  url.searchParams.set('query', query)
  url.searchParams.set('perspective', perspective)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(`$${k}`, JSON.stringify(v))
  const res = await fetch(url, {headers: {Authorization: `Bearer ${cfg.token}`}})
  if (!res.ok) throw new Error(`Sanity query failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as {result: T}
  return body.result
}
