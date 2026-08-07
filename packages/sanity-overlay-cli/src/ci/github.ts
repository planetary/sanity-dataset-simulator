/**
 * The GitHub half of PRD §37 Phase 6: "Report conflict summary on PR" and
 * "Refresh PR status when drift changes conflicts".
 *
 * ## Why this file is shaped like this
 *
 * Neither task can be tested against real GitHub from this repository — there
 * are no CI secrets here by design (§39.2 D14, "trusted-repository with no fork
 * secrets"), and a test that needed a token would be a test that never runs. So
 * the split is deliberate and total:
 *
 * - **Decisions are pure functions.** `planConflictComment` and
 *   `planCommitStatus` take data and return an intent. They are the whole of the
 *   behaviour worth asserting: *which* comment, *whether* to refresh, *what*
 *   state. The suite runs them directly.
 * - **Delivery is an injected {@link GitHubClient}.** `publishPrReport` performs
 *   the plan against whatever client it is handed, so the suite asserts the
 *   exact calls a real run would make without a network.
 * - **The transport is the only untested part**, and it is deliberately the
 *   thinnest thing in the file: {@link createHttpGitHubClient} is four `fetch`
 *   calls with no branching beyond error handling. Everything with a decision in
 *   it lives above it.
 *
 * A run with no token does NOT quietly succeed. `publishPrReport` is never
 * reached; the command reports a skip with the reason, and a skip fails the run
 * unless the invocation named it in `--allow-skip`.
 */

export interface GitHubIssueComment {
  readonly id: number
  readonly body: string
}

/** The four operations the two §37 Phase 6 PR tasks need. Nothing more. */
export interface GitHubClient {
  listIssueComments(input: {
    owner: string
    repo: string
    issue: number
  }): Promise<readonly GitHubIssueComment[]>
  createIssueComment(input: {
    owner: string
    repo: string
    issue: number
    body: string
  }): Promise<{id: number}>
  updateIssueComment(input: {
    owner: string
    repo: string
    commentId: number
    body: string
  }): Promise<void>
  createCommitStatus(input: {
    owner: string
    repo: string
    sha: string
    state: CommitStatusState
    context: string
    description: string
  }): Promise<void>
}

export type CommitStatusState = 'success' | 'failure'

/** The commit-status context, so re-runs replace the same check rather than pile up. */
export const COMMIT_STATUS_CONTEXT = 'sanity-overlay/conflicts'

export {CONFLICT_COMMENT_MARKER} from './report'
import {CONFLICT_COMMENT_MARKER} from './report'

export type CommentPlan =
  | {readonly action: 'create'}
  | {readonly action: 'update'; readonly commentId: number}
  | {readonly action: 'unchanged'; readonly commentId: number}

/**
 * One conflict comment per pull request, identified by the HTML marker.
 *
 * Updating in place rather than appending is not a nicety: a report appended on
 * every push is a report nobody reads by the third commit, and the reviewer ends
 * up acting on a stale one.
 *
 * An identical body is `unchanged` — a no-op write would move the comment's
 * `updatedAt` and re-notify every subscriber for no new information.
 */
export function planConflictComment(
  existing: readonly GitHubIssueComment[],
  body: string,
): CommentPlan {
  const mine = existing.find((comment) => comment.body.includes(CONFLICT_COMMENT_MARKER))
  if (mine === undefined) return {action: 'create'}
  if (mine.body.trim() === body.trim()) return {action: 'unchanged', commentId: mine.id}
  return {action: 'update', commentId: mine.id}
}

export interface ConflictCounts {
  readonly total: number
  readonly hard: number
  readonly soft: number
}

export interface CommitStatusPlan {
  /** PRD §16.6 — "Update … only when the conflict summary changes." */
  readonly changed: boolean
  readonly state: CommitStatusState
  readonly context: string
  readonly description: string
}

export function countsEqual(a: ConflictCounts, b: ConflictCounts): boolean {
  return a.total === b.total && a.hard === b.hard && a.soft === b.soft
}

/**
 * PRD §16.6: "Recompute conflict summaries without changing local intent …
 * Update the manifest conditionally only when the conflict summary changes.
 * Refresh the pull request status check and conflict summary."
 *
 * `changed` answers the conditional. It is `true` on the first scan (no previous
 * summary is not the same as an equal one) and whenever any of the three counts
 * moves — including downwards, because a conflict that resolved itself when the
 * base moved back must clear a red check, not leave one standing.
 *
 * The state is decided by HARD conflicts alone. §17.4 is what blocks preview,
 * publish and promotion; failing a PR for a soft conflict would make the §28.3
 * resolution actions pointless, since a soft conflict is one the merge already
 * resolved and merely wants acknowledged.
 */
export function planCommitStatus(
  previous: ConflictCounts | null,
  current: ConflictCounts,
): CommitStatusPlan {
  const changed = previous === null || !countsEqual(previous, current)
  const state: CommitStatusState = current.hard > 0 ? 'failure' : 'success'
  const description =
    current.hard > 0
      ? `${current.hard} hard conflict${current.hard === 1 ? '' : 's'} block branch publish (PRD §17.4)`
      : current.total > 0
        ? `${current.total} soft conflict${current.total === 1 ? '' : 's'} awaiting acknowledgement`
        : 'no unresolved conflicts'
  return {changed, state, context: COMMIT_STATUS_CONTEXT, description}
}

export interface PrTarget {
  readonly owner: string
  readonly repo: string
  readonly pullNumber: number
  readonly sha: string
}

/** `owner/repo`, the shape `GITHUB_REPOSITORY` carries. */
export function parseRepository(slug: string): {owner: string; repo: string} {
  const parts = slug.split('/')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error(`Repository must be "owner/repo", got ${JSON.stringify(slug)}`)
  }
  return {owner: parts[0]!, repo: parts[1]!}
}

export interface PrReportResult {
  readonly comment: CommentPlan
  readonly status: CommitStatusPlan
  /** `false` when §16.6's conditional said the summary had not changed. */
  readonly statusSent: boolean
}

/** Execute the two plans against an injected client. No decision happens here. */
export async function publishPrReport(input: {
  readonly client: GitHubClient
  readonly target: PrTarget
  readonly body: string
  readonly previous: ConflictCounts | null
  readonly current: ConflictCounts
}): Promise<PrReportResult> {
  const {client, target, body, previous, current} = input
  const existing = await client.listIssueComments({
    owner: target.owner,
    repo: target.repo,
    issue: target.pullNumber,
  })
  const comment = planConflictComment(existing, body)
  if (comment.action === 'create') {
    await client.createIssueComment({
      owner: target.owner,
      repo: target.repo,
      issue: target.pullNumber,
      body,
    })
  } else if (comment.action === 'update') {
    await client.updateIssueComment({
      owner: target.owner,
      repo: target.repo,
      commentId: comment.commentId,
      body,
    })
  }

  const status = planCommitStatus(previous, current)
  if (status.changed) {
    await client.createCommitStatus({
      owner: target.owner,
      repo: target.repo,
      sha: target.sha,
      state: status.state,
      context: status.context,
      description: status.description,
    })
  }

  return {comment, status, statusSent: status.changed}
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
  json(): Promise<unknown>
}>

/**
 * The real client: four `fetch` calls, `node:` built-ins only, no SDK.
 *
 * `fetch` is injected rather than closed over so the module has no ambient
 * dependency; the command passes the global.
 */
export function createHttpGitHubClient(options: {
  readonly token: string
  readonly fetch: FetchLike
  readonly apiUrl?: string
}): GitHubClient {
  const api = (options.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${options.token}`,
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  }

  const call = async (path: string, init: Record<string, unknown> = {}): Promise<unknown> => {
    const response = await options.fetch(`${api}${path}`, {...init, headers})
    if (!response.ok) {
      throw new Error(`GitHub ${String(init.method ?? 'GET')} ${path} failed: ${response.status} ${await response.text()}`)
    }
    return response.json()
  }

  return {
    async listIssueComments({owner, repo, issue}) {
      const body = await call(`/repos/${owner}/${repo}/issues/${issue}/comments?per_page=100`)
      if (!Array.isArray(body)) return []
      return body
        .filter((entry): entry is {id: number; body: string} =>
          entry !== null &&
          typeof entry === 'object' &&
          typeof (entry as {id?: unknown}).id === 'number' &&
          typeof (entry as {body?: unknown}).body === 'string',
        )
        .map((entry) => ({id: entry.id, body: entry.body}))
    },
    async createIssueComment({owner, repo, issue, body}) {
      const created = await call(`/repos/${owner}/${repo}/issues/${issue}/comments`, {
        method: 'POST',
        body: JSON.stringify({body}),
      })
      const id = (created as {id?: unknown} | null)?.id
      return {id: typeof id === 'number' ? id : 0}
    },
    async updateIssueComment({owner, repo, commentId, body}) {
      await call(`/repos/${owner}/${repo}/issues/comments/${commentId}`, {
        method: 'PATCH',
        body: JSON.stringify({body}),
      })
    },
    async createCommitStatus({owner, repo, sha, state, context, description}) {
      await call(`/repos/${owner}/${repo}/statuses/${sha}`, {
        method: 'POST',
        body: JSON.stringify({state, context, description}),
      })
    },
  }
}
