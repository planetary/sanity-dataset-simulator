/**
 * Rendering a {@link CiReport}.
 *
 * Two audiences, two formats, one rule shared by both: the `measured` counts go
 * in. A CI log that says "overlay-schemas: pass" is indistinguishable from a CI
 * log produced by a gate that scanned an empty directory, and the second one is
 * what actually happens when a path argument goes stale. `documents=2
 * invariants=12 checksums=6` is the difference between a gate and a sticker.
 */
import {plural, table} from '../render'
import type {CiReport, CiCheckResult} from './checks'
import type {ConflictSummaryDetail} from './overlayChecks'

function measuredText(measured: Readonly<Record<string, number>>): string {
  const entries = Object.entries(measured)
  if (entries.length === 0) return '-'
  return entries.map(([key, value]) => `${key}=${value}`).join(' ')
}

export function renderCiText(report: CiReport): string[] {
  const lines: string[] = [
    `sanity-overlay ci — PRD §37 Phase 6 CI checks over ${report.overlayId ?? report.root}`,
    '',
  ]

  const rows: string[][] = [['CHECK', 'STATUS', 'FINDINGS', 'MEASURED']]
  for (const check of report.checks) {
    rows.push([
      check.check,
      check.status,
      String(check.findings.length),
      measuredText(check.measured),
    ])
  }
  lines.push(...table(rows))

  for (const check of report.checks) {
    if (check.status === 'skip') {
      lines.push('', `${check.check}: SKIPPED — ${check.skipReason ?? 'no reason given'}`)
      continue
    }
    if (check.findings.length === 0) continue
    lines.push('', `${check.check} — ${check.task}`)
    for (const finding of check.findings) {
      lines.push(`  ${finding.severity.padEnd(7)} ${finding.ref ?? '-'}  ${finding.message}`)
    }
  }

  const pass = report.checks.filter((check) => check.status === 'pass').length
  const fail = report.checks.filter((check) => check.status === 'fail').length
  const skip = report.checks.filter((check) => check.status === 'skip').length
  lines.push(
    '',
    `${plural(report.checks.length, 'check')}: ${pass} pass, ${fail} fail, ${skip} skip`,
  )
  if (report.skipped.length > 0) {
    lines.push(
      `skipped without --allow-skip: ${report.skipped.join(', ')} — a check that cannot run is not a check that passed.`,
    )
  }
  if (report.prReport !== undefined) {
    lines.push(
      report.prReport.status === 'sent'
        ? `pull request report: ${report.prReport.comment ?? 'comment'}; status ${report.prReport.commitStatus ?? '-'}`
        : `pull request report: SKIPPED — ${report.prReport.reason ?? 'no reason given'}`,
    )
  }
  return lines
}

export interface ConflictMarkdownInput {
  readonly report: CiReport
  readonly summary: {total: number; hard: number; soft: number}
  readonly manifestSummary: {total: number; hard: number; soft: number}
  readonly conflicts: readonly ConflictSummaryDetail[]
  readonly drift?: {
    readonly changed: boolean
    readonly recomputed: {total: number; hard: number; soft: number}
    readonly driftedDocuments: readonly string[]
  }
}

/**
 * A marker comment, so a re-run UPDATES the same PR comment rather than adding
 * a new one on every push. A conflict report that appends is a conflict report
 * nobody reads by the third commit.
 */
export const CONFLICT_COMMENT_MARKER = '<!-- sanity-overlay:conflict-summary -->'

/** The PRD §37 Phase 6 "Report conflict summary on PR" body. */
export function renderConflictMarkdown(input: ConflictMarkdownInput): string {
  const {report, summary, manifestSummary, conflicts, drift} = input
  const lines: string[] = [
    CONFLICT_COMMENT_MARKER,
    `### Sanity overlay — conflict summary`,
    '',
    `Overlay \`${report.overlayId ?? report.root}\``,
    '',
    '| Metric | Manifest (PRD §13.1) | Scanned records (PRD §13.3) |',
    '| --- | ---: | ---: |',
    `| Total conflicts | ${manifestSummary.total} | ${summary.total} |`,
    `| Hard (blocks publish, §17.4) | ${manifestSummary.hard} | ${summary.hard} |`,
    `| Soft | ${manifestSummary.soft} | ${summary.soft} |`,
  ]

  if (conflicts.length > 0) {
    lines.push(
      '',
      '| Document | Type | Severity | Path | State |',
      '| --- | --- | --- | --- | --- |',
    )
    for (const conflict of conflicts) {
      lines.push(
        `| \`${conflict.documentId}\` | ${conflict.type} | ${conflict.severity} | ${
          conflict.path === null ? '—' : `\`${conflict.path}\``
        } | ${conflict.resolved ? 'resolved' : '**unresolved**'} |`,
      )
    }
  } else {
    lines.push('', 'No conflicts recorded on any document record.')
  }

  if (drift !== undefined) {
    lines.push(
      '',
      '#### Base drift scan (PRD §16.6)',
      '',
      drift.changed
        ? `Base drift **changed** the conflict summary: recomputed total=${drift.recomputed.total}, hard=${drift.recomputed.hard}, soft=${drift.recomputed.soft}.`
        : 'Base drift did not change the conflict summary.',
    )
    if (drift.driftedDocuments.length > 0) {
      lines.push(
        '',
        `Documents whose base moved since first touch: ${drift.driftedDocuments
          .map((id) => `\`${id}\``)
          .join(', ')}.`,
      )
    }
  }

  lines.push(
    '',
    '<sub>Generated by `sanity-overlay ci`. This scan never writes to the overlay (PRD §16.6).</sub>',
  )
  return lines.join('\n')
}

/** One line per check, for a job summary or a status-check description. */
export function renderCheckLine(check: CiCheckResult): string {
  return `${check.check}=${check.status}(${measuredText(check.measured)})`
}
