// SPIKE D compatibility scanner prototype — produces the PRD §20.3 findings
// for a (branch schema artifact, resolved documents) pair. Spike-grade: unions
// and Portable Text internals are validated shallowly; noted in the report.
import type {FixtureDocument} from '../src/fixtures'
import {type ArtifactValue, type SchemaArtifact, documentTypes, resolveValue} from './artifact'

export type FindingCode =
  | 'UNKNOWN_TYPE' // base doc _type absent from branch schema (§20.2 remove type)
  | 'MISSING_REQUIRED_FIELD'
  | 'TYPE_MISMATCH'
  | 'INVALID_ARRAY_MEMBER'
  | 'DISALLOWED_REFERENCE_TARGET'
  | 'UNKNOWN_FIELD' // data present, field gone from schema (§20.2 remove/reshape)

export interface Finding {
  code: FindingCode
  severity: 'hard' | 'soft'
  documentId: string
  path: string
  detail: string
}

const SYSTEM = new Set(['_id', '_type', '_createdAt', '_updatedAt', '_rev', '_key', '_weak', '_ref'])

export function scan(
  artifact: SchemaArtifact,
  docs: FixtureDocument[],
  byId?: Map<string, FixtureDocument>,
): Finding[] {
  const findings: Finding[] = []
  const docTypes = documentTypes(artifact)
  const index = byId ?? new Map(docs.map((d) => [d._id, d]))

  for (const doc of docs) {
    const def = docTypes.get(doc._type)
    if (!def) {
      findings.push({
        code: 'UNKNOWN_TYPE', severity: 'hard', documentId: doc._id, path: '',
        detail: `_type "${doc._type}" is not in the branch schema; hide, migrate, or passthrough policy required (§20.2)`,
      })
      continue
    }
    scanObject(doc, def.attributes ?? {}, doc._id, '', artifact, index, findings)
  }
  return findings
}

function scanObject(
  value: Record<string, unknown>,
  attributes: Record<string, {value: ArtifactValue; optional?: boolean}>,
  documentId: string,
  basePath: string,
  artifact: SchemaArtifact,
  index: Map<string, FixtureDocument>,
  findings: Finding[],
): void {
  for (const [field, attr] of Object.entries(attributes)) {
    if (SYSTEM.has(field)) continue
    const path = basePath ? `${basePath}.${field}` : field
    const v = value[field]
    if (v === undefined || v === null) {
      if (attr.optional === false) {
        findings.push({code: 'MISSING_REQUIRED_FIELD', severity: 'hard', documentId, path, detail: `required field absent`})
      }
      continue
    }
    checkValue(v, resolveValue(artifact, attr.value), documentId, path, artifact, index, findings)
  }
  // Data present in the document but absent from the schema (§20.2 remove field)
  for (const field of Object.keys(value)) {
    if (SYSTEM.has(field) || field in attributes) continue
    const path = basePath ? `${basePath}.${field}` : field
    findings.push({code: 'UNKNOWN_FIELD', severity: 'soft', documentId, path, detail: `data exists but field is not in the branch schema; hidden in Studio, optional cleanup migration (§20.2)`})
  }
}

function checkValue(
  v: unknown,
  spec: ArtifactValue,
  documentId: string,
  path: string,
  artifact: SchemaArtifact,
  index: Map<string, FixtureDocument>,
  findings: Finding[],
): void {
  const mismatch = (detail: string) =>
    findings.push({code: 'TYPE_MISMATCH', severity: 'hard', documentId, path, detail})

  switch (spec.type) {
    case 'string':
      if (typeof v !== 'string') return mismatch(`expected string, got ${typeof v}`)
      if (typeof spec.value === 'string' && v !== spec.value) return mismatch(`expected literal "${spec.value}"`)
      return
    case 'number':
      if (typeof v !== 'number') return mismatch(`expected number, got ${typeof v}`)
      return
    case 'boolean':
      if (typeof v !== 'boolean') return mismatch(`expected boolean, got ${typeof v}`)
      return
    case 'object': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return mismatch(`expected object, got ${Array.isArray(v) ? 'array' : typeof v}`)
      const obj = v as Record<string, unknown>
      // Reference object: enforce dereference target type
      if (spec.dereferencesTo && typeof obj._ref === 'string') {
        const target = index.get(obj._ref)
        if (target && target._type !== spec.dereferencesTo) {
          findings.push({
            code: 'DISALLOWED_REFERENCE_TARGET', severity: 'hard', documentId, path,
            detail: `reference to ${obj._ref} (_type "${target._type}") but schema allows "${spec.dereferencesTo}"`,
          })
        }
        return
      }
      if (spec.attributes) scanObject(obj, spec.attributes, documentId, path, artifact, index, findings)
      return
    }
    case 'array': {
      if (!Array.isArray(v)) return mismatch(`expected array, got ${typeof v}`)
      const members = Array.isArray(spec.of) ? spec.of : spec.of ? [spec.of] : []
      const options = members.flatMap((m) => {
        const r = resolveValue(artifact, m)
        return r.type === 'union' ? (Array.isArray(r.of) ? r.of : []).map((u) => resolveValue(artifact, u)) : [r]
      })
      for (let i = 0; i < v.length; i++) {
        const item = v[i]
        const itemPath = `${path}[${i}]`
        const ok = options.some((opt) => matchesShallow(item, opt))
        if (!ok && options.length > 0) {
          findings.push({code: 'INVALID_ARRAY_MEMBER', severity: 'hard', documentId, path: itemPath, detail: `member does not match any allowed array type`})
        } else if (ok && options.length === 1) {
          checkValue(item, options[0], documentId, itemPath, artifact, index, findings)
        }
        // union with multiple matches: shallow acceptance (spike-grade)
      }
      return
    }
    default:
      return // 'inline' already resolved; unknown kinds tolerated at spike level
  }
}

function matchesShallow(item: unknown, spec: ArtifactValue): boolean {
  if (spec.type === 'string') return typeof item === 'string'
  if (spec.type === 'number') return typeof item === 'number'
  if (spec.type === 'boolean') return typeof item === 'boolean'
  if (spec.type === 'object') {
    if (typeof item !== 'object' || item === null) return false
    const t = (item as Record<string, unknown>)._type
    const specT = spec.attributes?._type?.value
    if (typeof t === 'string' && specT && typeof specT.value === 'string') return t === specT.value
    return true
  }
  return true
}
