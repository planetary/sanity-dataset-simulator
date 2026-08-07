/**
 * PRD §37 Phase 6 — "Report conflict summary on PR" and "Refresh PR status when
 * drift changes conflicts".
 *
 * NEITHER CAN BE TESTED AGAINST REAL GITHUB FROM THIS REPOSITORY, and pretending
 * otherwise is the failure mode. There are no CI secrets here by design (§39.2
 * D14: trusted-repository, no fork secrets), so a test that needed a token would
 * be a test that never runs, and a green suite would mean "skipped".
 *
 * So the split is total, and this file is the whole of the tested half:
 *
 * - The DECISIONS — which comment, whether to refresh, what state — are pure
 *   functions asserted directly.
 * - The DELIVERY is asserted against a recording client, so the exact call
 *   sequence a real run would make is pinned without a network.
 * - The TRANSPORT (four `fetch` calls in `createHttpGitHubClient`) is exercised
 *   against a fake `fetch`, so the URLs, methods and auth header are pinned too;
 *   what is NOT proven here is that GitHub accepts them, and nothing in this
 *   file claims otherwise.
 */
import {describe, expect, it} from 'vitest'
import {
  COMMIT_STATUS_CONTEXT,
  CONFLICT_COMMENT_MARKER,
  countsEqual,
  createHttpGitHubClient,
  parseRepository,
  planCommitStatus,
  planConflictComment,
  publishPrReport,
  renderConflictMarkdown,
  type ConflictCounts,
  type GitHubClient,
  type GitHubIssueComment,
} from '../../sanity-overlay-cli/src/index'

const CLEAN: ConflictCounts = {total: 0, hard: 0, soft: 0}
const SOFT_ONLY: ConflictCounts = {total: 2, hard: 0, soft: 2}
const HARD: ConflictCounts = {total: 3, hard: 1, soft: 2}

interface Call {
  readonly kind: string
  readonly args: Record<string, unknown>
}

function recordingClient(existing: readonly GitHubIssueComment[] = []): {
  client: GitHubClient
  calls: Call[]
} {
  const calls: Call[] = []
  const client: GitHubClient = {
    async listIssueComments(args) {
      calls.push({kind: 'listIssueComments', args})
      return existing
    },
    async createIssueComment(args) {
      calls.push({kind: 'createIssueComment', args})
      return {id: 999}
    },
    async updateIssueComment(args) {
      calls.push({kind: 'updateIssueComment', args})
    },
    async createCommitStatus(args) {
      calls.push({kind: 'createCommitStatus', args})
    },
  }
  return {client, calls}
}

const TARGET = {owner: 'planetary', repo: 'sanity-dataset-simulator', pullNumber: 42, sha: 'abc123'}

/* ------------------------------------------------------------------ *
 * The comment plan
 * ------------------------------------------------------------------ */

describe('planConflictComment', () => {
  it('creates when the pull request carries no overlay comment yet', () => {
    expect(planConflictComment([], 'body')).toEqual({action: 'create'})
  })

  it('ignores comments that are not the overlay report', () => {
    const existing = [
      {id: 1, body: 'LGTM'},
      {id: 2, body: 'ship it'},
    ]
    expect(planConflictComment(existing, 'body')).toEqual({action: 'create'})
  })

  it('updates the marked comment in place rather than appending a second one', () => {
    const existing = [
      {id: 1, body: 'LGTM'},
      {id: 7, body: `${CONFLICT_COMMENT_MARKER}\nold report`},
    ]
    expect(planConflictComment(existing, 'new report')).toEqual({action: 'update', commentId: 7})
  })

  it('writes nothing when the body is unchanged, so a re-run does not re-notify', () => {
    const body = `${CONFLICT_COMMENT_MARKER}\nsame report`
    expect(planConflictComment([{id: 7, body}], body)).toEqual({action: 'unchanged', commentId: 7})
  })
})

/* ------------------------------------------------------------------ *
 * The status plan — PRD §16.6
 * ------------------------------------------------------------------ */

describe('planCommitStatus', () => {
  it('always refreshes on the first scan: no previous summary is not an equal one', () => {
    expect(planCommitStatus(null, CLEAN).changed).toBe(true)
  })

  it('does not refresh when the conflict summary is unchanged (PRD §16.6)', () => {
    expect(planCommitStatus(HARD, {...HARD}).changed).toBe(false)
  })

  it('refreshes when the summary changes, in either direction', () => {
    expect(planCommitStatus(CLEAN, HARD).changed).toBe(true)
    /* Downwards too: a conflict that cleared when the base moved back must
     * clear the red check, not leave one standing. */
    expect(planCommitStatus(HARD, CLEAN).changed).toBe(true)
  })

  it('distinguishes summaries that share a total', () => {
    expect(countsEqual({total: 2, hard: 2, soft: 0}, {total: 2, hard: 0, soft: 2})).toBe(false)
    expect(planCommitStatus({total: 2, hard: 2, soft: 0}, {total: 2, hard: 0, soft: 2}).changed).toBe(
      true,
    )
  })

  it('fails the check on a hard conflict, and only on a hard conflict (PRD §17.4)', () => {
    expect(planCommitStatus(null, HARD).state).toBe('failure')
    expect(planCommitStatus(null, SOFT_ONLY).state).toBe('success')
    expect(planCommitStatus(null, CLEAN).state).toBe('success')
  })

  it('says how many, and under one stable context so re-runs replace the check', () => {
    const plan = planCommitStatus(null, HARD)
    expect(plan.context).toBe(COMMIT_STATUS_CONTEXT)
    expect(plan.description).toContain('1 hard conflict')
    expect(planCommitStatus(null, CLEAN).description).toBe('no unresolved conflicts')
  })
})

/* ------------------------------------------------------------------ *
 * Delivery
 * ------------------------------------------------------------------ */

describe('publishPrReport', () => {
  it('creates the comment and posts the status on a first run', async () => {
    const {client, calls} = recordingClient([])
    const result = await publishPrReport({
      client,
      target: TARGET,
      body: 'report body',
      previous: null,
      current: HARD,
    })
    expect(result.comment).toEqual({action: 'create'})
    expect(result.statusSent).toBe(true)
    expect(calls.map((call) => call.kind)).toEqual([
      'listIssueComments',
      'createIssueComment',
      'createCommitStatus',
    ])
    expect(calls[2]!.args).toMatchObject({
      sha: 'abc123',
      state: 'failure',
      context: COMMIT_STATUS_CONTEXT,
    })
  })

  it('updates the existing comment and skips the status when nothing changed', async () => {
    const {client, calls} = recordingClient([{id: 7, body: `${CONFLICT_COMMENT_MARKER}\nold`}])
    const result = await publishPrReport({
      client,
      target: TARGET,
      body: 'new body',
      previous: HARD,
      current: {...HARD},
    })
    expect(result.comment).toEqual({action: 'update', commentId: 7})
    expect(result.statusSent).toBe(false)
    /* §16.6's conditional, made observable: no createCommitStatus call at all. */
    expect(calls.map((call) => call.kind)).toEqual(['listIssueComments', 'updateIssueComment'])
  })

  it('writes nothing at all when both the body and the summary are unchanged', async () => {
    const body = `${CONFLICT_COMMENT_MARKER}\nsame`
    const {client, calls} = recordingClient([{id: 7, body}])
    const result = await publishPrReport({
      client,
      target: TARGET,
      body,
      previous: CLEAN,
      current: {...CLEAN},
    })
    expect(result.comment).toEqual({action: 'unchanged', commentId: 7})
    expect(calls.map((call) => call.kind)).toEqual(['listIssueComments'])
  })
})

/* ------------------------------------------------------------------ *
 * The markdown body
 * ------------------------------------------------------------------ */

describe('renderConflictMarkdown', () => {
  const report = {
    ok: false,
    root: '/repo',
    overlayId: 'pr-42',
    checks: [],
    failed: [],
    skipped: [],
  } as const

  it('carries the marker so the next run can find its own comment', () => {
    const body = renderConflictMarkdown({
      report,
      summary: CLEAN,
      manifestSummary: CLEAN,
      conflicts: [],
    })
    expect(body.startsWith(CONFLICT_COMMENT_MARKER)).toBe(true)
    expect(planConflictComment([{id: 1, body}], body)).toEqual({action: 'unchanged', commentId: 1})
  })

  it('shows the manifest summary and the scanned records side by side', () => {
    const body = renderConflictMarkdown({
      report,
      summary: {total: 3, hard: 1, soft: 2},
      manifestSummary: {total: 0, hard: 0, soft: 0},
      conflicts: [
        {documentId: 'article-1', type: 'concurrent-edit', severity: 'hard', path: 'title', resolved: false},
      ],
    })
    /* The two columns disagreeing is the whole point of printing both: a
     * manifest summary that has fallen behind the records is what §16.6's
     * scheduled scan exists to surface. */
    expect(body).toContain('| Total conflicts | 0 | 3 |')
    expect(body).toContain('`article-1`')
    expect(body).toContain('**unresolved**')
  })

  it('appends the §16.6 drift verdict when a scan ran', () => {
    const body = renderConflictMarkdown({
      report,
      summary: CLEAN,
      manifestSummary: CLEAN,
      conflicts: [],
      drift: {changed: true, recomputed: HARD, driftedDocuments: ['article-1']},
    })
    expect(body).toContain('Base drift scan (PRD §16.6)')
    expect(body).toContain('**changed**')
    expect(body).toContain('`article-1`')
  })

  it('says so when there is nothing to report, rather than printing an empty table', () => {
    const body = renderConflictMarkdown({
      report,
      summary: CLEAN,
      manifestSummary: CLEAN,
      conflicts: [],
    })
    expect(body).toContain('No conflicts recorded')
  })
})

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

describe('createHttpGitHubClient', () => {
  interface Request {
    url: string
    init: Record<string, unknown>
  }

  function fakeFetch(requests: Request[], body: unknown = []) {
    return async (url: string, init: Record<string, unknown> = {}) => {
      requests.push({url, init})
      return {
        ok: true,
        status: 200,
        async text() {
          return ''
        },
        async json() {
          return body
        },
      }
    }
  }

  it('reads comments from the issues endpoint with a bearer token', async () => {
    const requests: Request[] = []
    const client = createHttpGitHubClient({
      token: 'ghs_secret',
      fetch: fakeFetch(requests, [{id: 5, body: 'hi'}, {id: 'bad'}]),
    })
    const comments = await client.listIssueComments({owner: 'o', repo: 'r', issue: 3})
    /* Malformed entries are dropped rather than crashing the report. */
    expect(comments).toEqual([{id: 5, body: 'hi'}])
    expect(requests[0]!.url).toBe('https://api.github.com/repos/o/r/issues/3/comments?per_page=100')
    expect((requests[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer ghs_secret',
    )
  })

  it('POSTs a commit status to the statuses endpoint', async () => {
    const requests: Request[] = []
    const client = createHttpGitHubClient({token: 't', fetch: fakeFetch(requests, {})})
    await client.createCommitStatus({
      owner: 'o',
      repo: 'r',
      sha: 'deadbeef',
      state: 'failure',
      context: COMMIT_STATUS_CONTEXT,
      description: 'nope',
    })
    expect(requests[0]!.url).toBe('https://api.github.com/repos/o/r/statuses/deadbeef')
    expect(requests[0]!.init.method).toBe('POST')
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
      state: 'failure',
      context: COMMIT_STATUS_CONTEXT,
      description: 'nope',
    })
  })

  it('throws with the status code rather than reporting a silent success', async () => {
    const client = createHttpGitHubClient({
      token: 't',
      fetch: async () => ({
        ok: false,
        status: 403,
        async text() {
          return 'Resource not accessible by integration'
        },
        async json() {
          return {}
        },
      }),
    })
    await expect(
      client.createCommitStatus({
        owner: 'o',
        repo: 'r',
        sha: 's',
        state: 'success',
        context: 'c',
        description: 'd',
      }),
    ).rejects.toThrow(/403/)
  })
})

describe('parseRepository', () => {
  it('reads the GITHUB_REPOSITORY shape', () => {
    expect(parseRepository('planetary/overlay')).toEqual({owner: 'planetary', repo: 'overlay'})
  })

  it('refuses anything else instead of guessing an owner', () => {
    expect(() => parseRepository('overlay')).toThrow(/owner\/repo/)
    expect(() => parseRepository('a/b/c')).toThrow(/owner\/repo/)
    expect(() => parseRepository('/b')).toThrow(/owner\/repo/)
  })
})
