/**
 * Repository-level CI gates. Roadmap Phase 7 "CI" (PRD §37 Phase 6).
 *
 * These are the checks that are about the REPOSITORY rather than about an
 * overlay: what the suite actually ran, what evidence is pinned, what is
 * allowed into the index, and what a fork pull request is configured with.
 * Overlay-shaped checks live in `sanity-overlay ci` and are invoked from the
 * same workflow; nothing here duplicates them.
 *
 * ── DESIGN: pure functions, injected inputs ──────────────────────────────
 *
 * Every gate is a pure function over data. Reading the data — a JSON report,
 * `git ls-files`, file bytes — happens in `main()` at the bottom and nowhere
 * else. That split is the point: a `run:` line in a workflow can only ever be
 * observed in the state it passes in, so a gate expressed as shell is a gate
 * nobody has watched go red. Expressed this way, every failure mode has a case
 * in `packages/sanity-overlay-testkit/test/ci-repo-gates.test.ts` that hands it
 * the broken state directly.
 *
 * ── DESIGN: a gate must report its denominator ───────────────────────────
 *
 * Every result carries `measured`. Zero findings over zero inputs is the most
 * dangerous output a gate has, because it is indistinguishable from a clean
 * bill of health; the counts are how a reviewer tells them apart. Where the
 * denominator can legitimately be zero only by mistake — no test files, no
 * pins, no overlay, no workflows — that is itself a violation
 * (`empty-report`, `no-pins`, `no-overlay-found`, `no-workflows`), so a gate
 * cannot pass by inspecting nothing.
 *
 * Node built-ins only, no dependencies: this runs on a bare runner before any
 * install has necessarily succeeded.
 */

import {execFileSync} from 'node:child_process'
import {appendFileSync, existsSync, readFileSync, readdirSync, statSync} from 'node:fs'
import {join, relative, sep} from 'node:path'
import {fileURLToPath} from 'node:url'

/* ─────────────────────────────────────────────────────────── shared ── */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** A violation is always attributable: which gate, what kind, which thing. */
const violation = (gate, kind, ref, message) => ({gate, kind, ref, message})

const result = (violations, measured, extra = {}) => ({
  ok: violations.length === 0,
  violations,
  measured,
  ...extra,
})

/** `a/b/c.ts` matches the spec `b/c.ts`. Specs are written repo-relative-ish. */
const matchesSpec = (path, spec) => path === spec || path.endsWith(`/${spec}`)

/* ══════════════════════════════════════════════════ gate: suite skips ══ */

/**
 * PRD §35 / roadmap Phase 7: "Run query parity tests" and every other suite the
 * gate depends on must have RUN.
 *
 * Measured against vitest 4.1.10: a `describe.skipIf(cond)` whose condition is
 * true emits one `assertionResults` entry per test with `status: "skipped"`,
 * and the run reports `success: true`. `test/hosted-parity.test.ts` is exactly
 * that shape and its condition is "the gitignored repo-root .env is absent",
 * which is every CI run. So a credential-less run is byte-for-byte as green as
 * a credentialed one, and the twelve hosted parity cases Gate D cites as
 * evidence never execute.
 *
 * The rule: a skip is not a pass unless the invocation NAMED it. Same
 * discipline as `sanity-overlay ci --allow-skip`, and the same reason — the
 * workflow has to state, in configuration, which legs are inert and therefore
 * why. And the allowance is self-cleaning: naming a leg that DID run, or a file
 * that no longer exists, is also red, so an allowance cannot rot into a
 * permanent hole.
 *
 * @param report parsed `vitest run --reporter=json` output
 * @param required suites that must appear AND must have run
 * @param allowSkip suites permitted to be skipped in this invocation
 */
export function auditSkips({report, required = [], allowSkip = []}) {
  const violations = []
  const files = (report?.testResults ?? []).map((suite) => {
    const path = relative(REPO_ROOT, suite.name).split(sep).join('/')
    const statuses = (suite.assertionResults ?? []).map((a) => a.status)
    return {
      path,
      tests: statuses.length,
      passed: statuses.filter((s) => s === 'passed').length,
      failed: statuses.filter((s) => s === 'failed').length,
      /* `todo` counts as a skip. An unwritten test is a test that did not run,
       * and it reports green exactly like one that was gated out. */
      skipped: statuses.filter((s) => s === 'skipped' || s === 'todo').length,
      skippedNames: (suite.assertionResults ?? [])
        .filter((a) => a.status === 'skipped' || a.status === 'todo')
        .map((a) => a.fullName),
    }
  })

  const measured = {
    files: files.length,
    tests: files.reduce((n, f) => n + f.tests, 0),
    passed: files.reduce((n, f) => n + f.passed, 0),
    failed: files.reduce((n, f) => n + f.failed, 0),
    skipped: files.reduce((n, f) => n + f.skipped, 0),
    required: required.length,
    allowedSkips: allowSkip.length,
  }

  if (files.length === 0) {
    violations.push(
      violation(
        'skips',
        'empty-report',
        '(report)',
        'the vitest JSON report names no test file. A report with no files cannot show a skip, ' +
          'so this is refused rather than passed: check --outputFile, the runner exit, and any ' +
          'filter passed to `vitest run`.',
      ),
    )
    return result(violations, measured, {declared: []})
  }

  for (const spec of required) {
    if (allowSkip.some((s) => s === spec)) {
      violations.push(
        violation(
          'skips',
          'contradictory-configuration',
          spec,
          `is both --require and --allow-skip. One of them is wrong, and guessing which would ` +
            `turn a required suite into an optional one silently.`,
        ),
      )
    }
  }

  for (const spec of required) {
    const matched = files.filter((f) => matchesSpec(f.path, spec))
    if (matched.length === 0) {
      violations.push(
        violation(
          'skips',
          'required-missing',
          spec,
          `is required by this invocation and did not appear in the run at all. It was renamed, ` +
            `deleted, or excluded by a filter — in every case the guarantee it carries is no ` +
            `longer being enforced.`,
        ),
      )
      continue
    }
    for (const file of matched) {
      if (file.skipped > 0) {
        violations.push(
          violation(
            'skips',
            'required-skipped',
            file.path,
            `is required and skipped ${file.skipped} test(s): ${file.skippedNames.join('; ')}`,
          ),
        )
      }
      if (file.passed === 0) {
        violations.push(
          violation(
            'skips',
            'required-empty',
            file.path,
            `is required and reported ${file.passed} passing tests out of ${file.tests}. An ` +
              `emptied suite is the quiet form of a deleted one and gets the same colour.`,
          ),
        )
      }
    }
  }

  const declared = []
  for (const spec of allowSkip) {
    const matched = files.filter((f) => matchesSpec(f.path, spec))
    if (matched.length === 0) {
      violations.push(
        violation(
          'skips',
          'stale-allowance',
          spec,
          `is allowed to skip and names no test file in this run. The allowance now covers ` +
            `nothing and must be removed, or it will silently cover the next file that takes ` +
            `this name.`,
        ),
      )
      continue
    }
    for (const file of matched) {
      if (file.skipped === 0) {
        violations.push(
          violation(
            'skips',
            'stale-allowance',
            file.path,
            `is allowed to skip but ran in full (${file.passed}/${file.tests} passed). Drop the ` +
              `--allow-skip: keeping it means the next real skip in this file passes unnoticed.`,
          ),
        )
        continue
      }
      declared.push({file: file.path, skipped: file.skipped})
    }
  }

  const allowed = new Set(declared.map((d) => d.file))
  for (const file of files) {
    if (file.skipped === 0 || allowed.has(file.path)) continue
    if (required.some((spec) => matchesSpec(file.path, spec))) continue /* already reported */
    violations.push(
      violation(
        'skips',
        'unexpected-skip',
        file.path,
        `skipped ${file.skipped} of ${file.tests} test(s) and this run did not declare it: ` +
          `${file.skippedNames.join('; ')}. A skipped leg reports the same green as one that ` +
          `ran; if it is genuinely inert here, say so with --allow-skip ${file.path}.`,
      ),
    )
  }

  return result(violations, measured, {declared})
}

/* ═══════════════════════════════════════════════ gate: pinned evidence ══ */

/**
 * Files whose exact size IS the evidence.
 *
 * `proxy-log.jsonl` is the Spike F replay corpus. `.gitattributes` already
 * states that its 730-line count is asserted by the re-verification checklist
 * and that the replay harness splits it on '\n'; nothing actually asserted it,
 * so a regenerated or truncated log would have changed the evidence under the
 * conclusions drawn from it without anything going red.
 */
export const PINNED_EVIDENCE = [
  {
    path: 'examples/kitchen-sink/spikeB-proxy/proxy-log.jsonl',
    lines: 730,
    format: 'jsonl',
    why:
      'Spike F Track B replay evidence. The line count is cited in .gitattributes and the ' +
      'replay harness (test/proxy-log-replay.test.ts) splits it on \\n.',
  },
]

/**
 * @param files Map<path, Buffer> — bytes, not text: NUL and CRLF are the point.
 */
export function checkPinnedEvidence({files, pins = PINNED_EVIDENCE}) {
  const violations = []
  const measured = {pins: pins.length, bytes: 0, lines: 0}

  if (pins.length === 0) {
    violations.push(
      violation('pinned-evidence', 'no-pins', '(table)', 'the pin table is empty; nothing was checked.'),
    )
    return result(violations, measured)
  }

  for (const pin of pins) {
    const bytes = files.get(pin.path)
    if (bytes === undefined) {
      violations.push(
        violation('pinned-evidence', 'missing', pin.path, `is pinned at ${pin.lines} lines and is not present. ${pin.why}`),
      )
      continue
    }
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    measured.bytes += buf.length

    if (buf.includes(0)) {
      violations.push(
        violation(
          'pinned-evidence',
          'nul-byte',
          pin.path,
          'contains a NUL byte. Git would classify it binary, so every future change to this ' +
            'evidence becomes invisible to `git diff` and to `rg`.',
        ),
      )
    }
    if (buf.includes(0x0d)) {
      violations.push(
        violation(
          'pinned-evidence',
          'crlf',
          pin.path,
          'contains CR. .gitattributes pins `* text=auto eol=lf` precisely so this file survives ' +
            'a checkout unchanged; CRLF preserves the line count and corrupts every record.',
        ),
      )
    }

    const text = buf.toString('utf8')
    const lines = (text.match(/\n/g) ?? []).length
    measured.lines += lines
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) {
      violations.push(
        violation(
          'pinned-evidence',
          'no-trailing-newline',
          pin.path,
          'does not end with a newline, so "N lines" is ambiguous and the count above is not the ' +
            'record count.',
        ),
      )
    }
    if (lines !== pin.lines) {
      violations.push(
        violation(
          'pinned-evidence',
          'line-count',
          pin.path,
          `has ${lines} lines and is pinned at ${pin.lines}. ${pin.why} If the evidence genuinely ` +
            `changed, the conclusions drawn from it have to be re-derived before the pin moves.`,
        ),
      )
    }

    if (pin.format === 'jsonl') {
      const records = text.split('\n')
      /* A trailing newline yields one empty final element; it is not a record. */
      if (records.length > 0 && records[records.length - 1] === '') records.pop()
      for (const [index, line] of records.entries()) {
        try {
          JSON.parse(line)
        } catch (error) {
          violations.push(
            violation(
              'pinned-evidence',
              'invalid-jsonl',
              pin.path,
              `line ${index + 1} is not JSON: ${error.message}. Corruption that preserves the ` +
                `line count is exactly what a count-only check waves through.`,
            ),
          )
          break
        }
      }
    }
  }

  return result(violations, measured)
}

/* ═════════════════════════════════════════ gate: .sanity-overlay/ ══ */

/**
 * The `.gitignore` `FsOverlayStore` writes inside every `.sanity-overlay/`.
 *
 * Duplicated here as a LITERAL on purpose: this module is dependency-free Node
 * that runs before any install, so it cannot import the store. The duplication
 * is not allowed to drift — `test/ci-repo-gates.test.ts` asserts this equals
 * `GITIGNORE_CONTENT` exported by `sanity-overlay-store-fs`, so a pattern the
 * store learns to ignore and this file does not is red in the same commit.
 */
export const OVERLAY_GITIGNORE = `.runtime/
.locks/
.history/
*.broken
.tmp-*
`

/** The same content as a pattern list, which is what the path matcher needs. */
export const OVERLAY_RUNTIME_PATTERNS = OVERLAY_GITIGNORE.split('\n').filter(
  (line) => line.trim().length > 0,
)

const OVERLAY_DIR = '.sanity-overlay'

/** Canonical files that MUST be tracked: this is what makes branch state travel. */
const OVERLAY_REQUIRED_TRACKED = ['manifest.json']

/**
 * Does `remainder` (a path relative to an overlay root) match an ignored pattern?
 *
 * Only the two shapes the store's own .gitignore uses are supported —
 * `dir/` and a `*` prefix glob — because supporting more would mean
 * reimplementing gitignore, and the assertion above pins the file to exactly
 * these five lines.
 */
const matchesIgnoredPattern = (remainder) =>
  OVERLAY_RUNTIME_PATTERNS.some((pattern) => {
    if (pattern.endsWith('/')) return remainder === pattern.slice(0, -1) || remainder.startsWith(pattern)
    if (pattern.startsWith('*')) {
      const suffix = pattern.slice(1)
      return remainder.split('/').some((segment) => segment.endsWith(suffix))
    }
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1)
      return remainder.split('/').some((segment) => segment.startsWith(prefix))
    }
    return remainder.split('/').includes(pattern)
  })

/**
 * PRD §14.3, §23, §38.1: `.sanity-overlay/` is TRACKED, because it is the
 * mechanism by which branch state travels with the branch. §14.1: the runtime
 * scratch under it is not.
 *
 * Both halves have regressed in this repository. A blanket `.sanity-overlay/`
 * line in the root `.gitignore` (2026-08-04) silently defeated the first, and
 * runtime artifacts have reached the index twice for the second.
 *
 * ── WHY THIS IS PATH-BASED AND NEVER OPENS A FILE ────────────────────────
 *
 * Some `.runtime/` artifacts carry NUL bytes. Git classifies a blob containing
 * NUL as binary: `git diff` prints "Binary files ... differ", `rg` skips it.
 * That is how the artifact got committed twice without anyone seeing it in a
 * diff. A content-based check would miss exactly the case that has already
 * happened, so every decision below is made from `git ls-files` output — the
 * INDEX, so a file counts from the moment it is `git add`ed — and the only file
 * ever read is the overlay's own `.gitignore`.
 *
 * @param tracked repo-relative POSIX paths from `git ls-files`
 * @param onDisk overlay roots found on the filesystem (so a wholly-ignored
 *        overlay is still judged rather than disappearing from the audit)
 * @param read (path) => string | undefined
 * @param isIgnored (path) => boolean, from `git check-ignore`
 */
export function auditOverlayTracking({tracked, onDisk = [], read, isIgnored}) {
  const violations = []

  const rootOf = (path) => {
    const marker = `/${OVERLAY_DIR}/`
    const at = path.indexOf(marker)
    if (at >= 0) return path.slice(0, at + marker.length - 1)
    return path === OVERLAY_DIR || path.startsWith(`${OVERLAY_DIR}/`) ? OVERLAY_DIR : null
  }

  const roots = [...new Set([...onDisk, ...tracked.map(rootOf).filter((r) => r !== null)])].sort()

  const under = (root) => tracked.filter((p) => p.startsWith(`${root}/`))
  const measured = {
    roots: roots.length,
    tracked: roots.reduce((n, root) => n + under(root).length, 0),
    runtimeArtifacts: 0,
  }

  if (roots.length === 0) {
    violations.push(
      violation(
        'overlay-tracking',
        'no-overlay-found',
        `**/${OVERLAY_DIR}`,
        `no ${OVERLAY_DIR}/ directory was found, tracked or on disk. PRD §14.3 makes this ` +
          `directory the mechanism by which branch state travels with the branch, so a repository ` +
          `with none is either mis-scanned or has lost it — either way this gate inspected ` +
          `nothing and will not report success for it.`,
      ),
    )
    return result(violations, measured)
  }

  for (const root of roots) {
    const paths = under(root)

    for (const path of paths) {
      const remainder = path.slice(root.length + 1)
      if (!matchesIgnoredPattern(remainder)) continue
      measured.runtimeArtifacts += 1
      violations.push(
        violation(
          'overlay-tracking',
          'runtime-artifact-tracked',
          path,
          `is local runtime scratch (PRD §14.1) and is in the git index. The store's own ` +
            `${root}/.gitignore excludes it; something added it with -f, or the ignore file was ` +
            `absent when it was staged. Some of these artifacts carry NUL bytes and are therefore ` +
            `invisible to \`git diff\` — run \`git rm --cached\` on it.`,
        ),
      )
    }

    const gitignorePath = `${root}/.gitignore`
    if (!tracked.includes(gitignorePath)) {
      violations.push(
        violation(
          'overlay-tracking',
          'gitignore-not-tracked',
          gitignorePath,
          `is not tracked. FsOverlayStore writes it, but only a COMMITTED copy protects a fresh ` +
            `clone — and if the overlay directory itself is ignored, this is the first thing that ` +
            `goes missing.`,
        ),
      )
    } else {
      const content = read(gitignorePath)
      if (content !== OVERLAY_GITIGNORE) {
        violations.push(
          violation(
            'overlay-tracking',
            'gitignore-drifted',
            gitignorePath,
            `differs from what FsOverlayStore writes. Whatever it stopped excluding is now one ` +
              `\`git add .\` away from the index.`,
          ),
        )
      }
    }

    for (const required of OVERLAY_REQUIRED_TRACKED) {
      const path = `${root}/${required}`
      if (!tracked.includes(path)) {
        violations.push(
          violation(
            'overlay-tracking',
            'manifest-not-tracked',
            path,
            `is not tracked. PRD §14.3/§23/§38.1 require the canonical overlay files to be ` +
              `committed — §23 has a preview deployment read them out of the deployment bundle — ` +
              `so an untracked manifest means branch state does not travel with the branch.`,
          ),
        )
      }
    }

    if (isIgnored(`${root}/manifest.json`)) {
      violations.push(
        violation(
          'overlay-tracking',
          'overlay-ignored',
          root,
          `is matched by a gitignore rule. A blanket ignore of this directory was added in error ` +
            `on 2026-08-04 and removed on 2026-08-05; it silently defeats PRD §14.3, §23 and ` +
            `§38.1 at once, and nothing else in the suite can see it.`,
        ),
      )
    }
  }

  return result(violations, measured)
}

/* ═══════════════════════════════ gate: fork pull requests and secrets ══ */

/**
 * PRD §11.5 and §26.9:
 *
 *   [MUST] CI scans preview environment configuration for write-capable tokens.
 *   [MUST] CI identifies fork pull requests and verifies that draft read
 *          tokens, Blob credentials, overlay secrets, and promotion credentials
 *          are absent.
 *   [MUST][M-PREVIEW] CI detects fork origin and fails when protected overlay
 *          secrets are configured.
 *
 * ── WHAT THIS CHECKS, AND WHAT IT HONESTLY CANNOT ────────────────────────
 *
 * A step running inside a fork pull request cannot enumerate the repository's
 * secrets: GitHub does not pass them, so every `${{ secrets.X }}` there
 * expands to the empty string. A runtime check "are the secrets absent?" would
 * therefore pass unconditionally, on every fork PR, forever — a check that
 * cannot fail.
 *
 * What CAN fail, and is the only thing that ever could, is the CONFIGURATION:
 * whether a workflow reachable by `pull_request` references a repository secret
 * at all. If none does, absence on a fork is structural rather than hoped for.
 * `pull_request_target` is refused outright — it runs fork-authored code with
 * the base repository's full secret context, which is the exact thing §11.5
 * forbids.
 */
const SECRET_REF = /\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_-]*)/g

/** Read-only on a fork by construction, and the only secret a fork job may name. */
const FORK_SAFE_SECRETS = new Set(['GITHUB_TOKEN'])

/**
 * Full-line YAML comments, removed before anything is judged.
 *
 * These workflows document what they refuse, so `${{ secrets.X }}` and
 * `pull_request_target` appear in prose explaining why they are not used. A
 * scanner that read those would report the explanation as the offence.
 *
 * ONLY full-line comments. A trailing `# ${{ secrets.X }}` on a config line is
 * still read as a reference, and that is the deliberate direction of the
 * imprecision: over-reporting a comment costs one edit, under-reporting a
 * secret costs the guarantee.
 */
const withoutComments = (text) =>
  text
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n')

export function auditWorkflowSecrets({workflows}) {
  const violations = []
  let secretRefs = 0
  let pullRequestWorkflows = 0

  if (workflows.size === 0) {
    violations.push(
      violation(
        'workflow-secrets',
        'no-workflows',
        '.github/workflows',
        'no workflow files were found. This gate inspected nothing, so it reports nothing rather ' +
          'than success.',
      ),
    )
    return result(violations, {workflows: 0, secretRefs: 0, pullRequestWorkflows: 0})
  }

  for (const [name, raw] of workflows) {
    const text = withoutComments(raw)
    if (/^\s*pull_request_target\s*:/m.test(text) || /^on:.*\bpull_request_target\b/m.test(text)) {
      violations.push(
        violation(
          'workflow-secrets',
          'pull-request-target-trigger',
          name,
          'uses pull_request_target, which runs with the base repository\'s full secret context ' +
            'against fork-authored code. PRD §11.5 requires fork pull requests to have no access ' +
            'to overlay secrets; there is no configuration of this trigger that satisfies that.',
        ),
      )
    }

    const forkReachable = /^\s*pull_request\s*:/m.test(text) || /^on:.*\bpull_request\b/m.test(text)
    if (forkReachable) pullRequestWorkflows += 1

    const named = new Set()
    for (const match of text.matchAll(SECRET_REF)) {
      secretRefs += 1
      named.add(match[1])
    }
    if (!forkReachable) continue

    for (const secret of [...named].sort()) {
      if (FORK_SAFE_SECRETS.has(secret)) continue
      violations.push(
        violation(
          'workflow-secrets',
          'secret-on-pull-request',
          name,
          `is triggered by pull_request and references \${{ secrets.${secret} }}. PRD §11.5 ` +
            `requires draft read tokens, Blob credentials and overlay secrets to be absent on a ` +
            `fork pull request; the only way to guarantee that from inside the repository is not ` +
            `to configure them on a fork-reachable trigger. Move this job to a workflow_dispatch ` +
            `or schedule trigger.`,
        ),
      )
    }
  }

  return result(violations, {workflows: workflows.size, secretRefs, pullRequestWorkflows})
}

/* ═════════════════════════════════════ minimal workflow structure reader ══ */

/*
 * Two facts are read out of workflow YAML, and only two: the job ids, and the
 * `run:` command lines. A real YAML parser is deliberately not used — this
 * module must run on a bare runner with no install, and the pnpm store's `yaml`
 * is a transitive dependency nothing here may rely on. Both readers are
 * indentation-anchored and are exercised against the repository's real
 * workflows in the suite, so a shape they cannot read is red rather than empty.
 */

/** Job ids: two-space-indented keys inside the top-level `jobs:` block. */
export function workflowJobIds(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line))
  if (start < 0) return []
  const ids = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break /* next top-level key ends the block */
    const match = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(line)
    if (match) ids.push(match[1])
  }
  return ids
}

/**
 * Every `run:` command as one whitespace-collapsed string, including the folded
 * (`run: >`) and literal (`run: |`) block forms the workflows use.
 */
export function workflowRunLines(text) {
  const lines = text.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)-?\s*run:\s*(.*)$/.exec(lines[i])
    if (!match) continue
    const [, indent, first] = match
    if (first !== '>' && first !== '|' && first !== '>-' && first !== '|-') {
      out.push(first.trim())
      continue
    }
    const block = []
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]
      if (line.trim().length === 0) continue
      const lead = /^\s*/.exec(line)[0].length
      if (lead <= indent.length) break
      block.push(line.trim())
      i = j
    }
    out.push(block.join(' '))
  }
  return out
}

/* ══════════════════════════════════════════════════════════════ main ══ */

const gitLines = (args) =>
  execFileSync('git', args, {cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024})
    .split('\0')
    .filter((entry) => entry.length > 0)

const findOverlayDirs = (dir, out = []) => {
  let entries
  try {
    entries = readdirSync(dir, {withFileTypes: true})
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.name === OVERLAY_DIR) {
      out.push(relative(REPO_ROOT, full).split(sep).join('/'))
      continue /* do not descend: .runtime/ can be large */
    }
    findOverlayDirs(full, out)
  }
  return out
}

/**
 * `--no-index` is not optional, and leaving it off made this check silently
 * inert — caught by watching the gate FAIL to go red on the 2026-08-04 blanket
 * ignore.
 *
 * By default `git check-ignore` reports nothing for a path that is already in
 * the index, on the reasoning that a tracked file is not affected by ignore
 * rules. That is true of the file, and irrelevant to the damage: a blanket
 * `.sanity-overlay/` line does not untrack what is already committed, it stops
 * everything NEW from ever being added — which is exactly how the regression
 * went unnoticed for a day. The question this gate asks is "does a rule match
 * this path", and only `--no-index` answers that question.
 */
export const isGitIgnored = (path, cwd = REPO_ROOT) => {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', '--', path], {cwd, stdio: 'ignore'})
    return true
  } catch {
    return false
  }
}

const collect = (argv, flag) => {
  const out = []
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === flag) out.push(argv[i + 1])
  return out.filter((value) => value !== undefined)
}

const single = (argv, flag) => collect(argv, flag)[0]

/**
 * GitHub renders this in the checks UI, and the summary is where a DECLARED
 * skip actually gets seen — the log scrolls, the summary does not.
 *
 * `appendFileSync` is imported at the top of the module rather than required
 * here. It was `require('node:fs')` in the first draft, which is `undefined` in
 * an ES module: the call threw on every invocation and the catch below swallowed
 * it, so the summary was silently never written. Caught by running the wrapper
 * with GITHUB_STEP_SUMMARY set and finding an empty file.
 */
const summary = (lines) => {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (file === undefined || file.length === 0) return
  try {
    appendFileSync(file, `${lines.join('\n')}\n`)
  } catch {
    /* A summary that cannot be written must not fail the gate. */
  }
}

function report(gate, res, extra = []) {
  const measured = Object.entries(res.measured)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
  const head = `${gate}: ${res.ok ? 'PASS' : 'FAIL'} — measured ${measured}`
  const body = [
    head,
    ...extra,
    ...res.violations.map((v) => `  ✗ [${v.kind}] ${v.ref}\n      ${v.message}`),
  ]
  for (const line of body) console.log(line)
  summary(body.map((line) => (line === head ? `### ${line}` : `    ${line}`)))
  return res.ok ? 0 : 1
}

async function main(argv) {
  const gate = argv[0]
  switch (gate) {
    case 'skips': {
      const path = single(argv, '--report')
      if (path === undefined) throw new Error('skips: --report <vitest.json> is required')
      if (!existsSync(path)) throw new Error(`skips: no report at ${path}; the run wrote none`)
      const res = auditSkips({
        report: JSON.parse(readFileSync(path, 'utf8')),
        required: collect(argv, '--require'),
        allowSkip: collect(argv, '--allow-skip'),
      })
      return report(
        'skips',
        res,
        (res.declared ?? []).map(
          (d) => `  ! DECLARED NOT RUN: ${d.file} — ${d.skipped} test(s) skipped by configuration`,
        ),
      )
    }
    case 'pinned-evidence': {
      const files = new Map()
      for (const pin of PINNED_EVIDENCE) {
        const full = join(REPO_ROOT, pin.path)
        if (existsSync(full) && statSync(full).isFile()) files.set(pin.path, readFileSync(full))
      }
      return report('pinned-evidence', checkPinnedEvidence({files}))
    }
    case 'overlay-tracking': {
      const tracked = gitLines(['ls-files', '-z'])
      return report(
        'overlay-tracking',
        auditOverlayTracking({
          tracked,
          onDisk: findOverlayDirs(REPO_ROOT),
          read: (path) => {
            const full = join(REPO_ROOT, path)
            return existsSync(full) ? readFileSync(full, 'utf8') : undefined
          },
          isIgnored: isGitIgnored,
        }),
      )
    }
    case 'workflow-secrets': {
      /* The DIRECTORY, not `git ls-files`. A workflow only takes effect once
       * committed, so the index is the tempting oracle — but reading it would
       * make a newly added workflow invisible to this gate until after the
       * commit that adds it, which is precisely backwards. On a runner the two
       * agree, because the checkout produced the worktree. */
      const dir = join(REPO_ROOT, '.github/workflows')
      const workflows = new Map()
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue
        workflows.set(`.github/workflows/${name}`, readFileSync(join(dir, name), 'utf8'))
      }
      return report('workflow-secrets', auditWorkflowSecrets({workflows}))
    }
    default:
      throw new Error(
        `unknown gate ${JSON.stringify(gate)}; expected skips, pinned-evidence, overlay-tracking or workflow-secrets`,
      )
  }
}

/* Executed only as a script; importing this module runs nothing. */
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(`repo-gates: ${error.message}`)
      process.exitCode = 2
    },
  )
}
