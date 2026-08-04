/**
 * Hosted Sanity Query API access via fetch — no client dependency.
 * Used by the empty-overlay parity oracle (testing-strategy §2):
 * hosted result vs pinned groq-js over the same fixture must be equal.
 */
export interface HostedConfig {
  projectId: string
  dataset: string
  apiVersion: string
  token: string
}

export function hostedConfigFromEnv(): HostedConfig | null {
  const {SANITY_PROJECT_ID, SANITY_BASE_DATASET, SANITY_API_VERSION, SANITY_API_READ_TOKEN} = process.env
  if (!SANITY_PROJECT_ID || !SANITY_BASE_DATASET || !SANITY_API_READ_TOKEN) return null
  return {
    projectId: SANITY_PROJECT_ID,
    dataset: SANITY_BASE_DATASET,
    apiVersion: SANITY_API_VERSION || 'v2025-02-19',
    token: SANITY_API_READ_TOKEN,
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
