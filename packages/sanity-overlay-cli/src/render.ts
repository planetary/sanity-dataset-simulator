/**
 * Rendering helpers shared by every command.
 *
 * Two notations for a path exist in this system and they are not the same
 * thing. `encodeOverlayPath` (core) is the STORAGE identity — `$.body[_key=x]` —
 * and is what conflict IDs and dedup keys are built from. What a developer
 * reads in a diff is Sanity/GROQ notation — `body[_key=="x"].text` — which is
 * what they can paste into a query or a patch. {@link formatPath} produces the
 * second and is display-only; nothing keys off it.
 */
import {serialize} from 'sanity-overlay-core'
import type {OverlayPath} from 'sanity-overlay-core'

/** Display notation for an {@link OverlayPath}. Never used as an identity. */
export function formatPath(path: OverlayPath): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'string') out += out.length === 0 ? segment : `.${segment}`
    else if (typeof segment === 'number') out += `[${segment}]`
    else out += `[_key=="${segment._key}"]`
  }
  return out.length === 0 ? '$' : out
}

/** Canonical JSON with a trailing newline — deterministic key order (PRD §14.3). */
export function toJson(value: unknown): string {
  return serialize(value)
}

/** A compact one-value rendering for diff lines and tables. */
export function inline(value: unknown): string {
  if (value === undefined) return '<absent>'
  return JSON.stringify(value) ?? String(value)
}

/** `label` padded to `width`, for the aligned key/value blocks the commands print. */
export function field(label: string, value: string, width = 16): string {
  return `${label.padEnd(width)}${value}`
}

/** Render rows as a left-aligned table with two-space gutters. */
export function table(rows: readonly (readonly string[])[]): string[] {
  if (rows.length === 0) return []
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length)
    })
  }
  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join('  ')
      .trimEnd(),
  )
}

/** `n thing` / `n things`, so counts read as English rather than as `1 violation(s)`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}
