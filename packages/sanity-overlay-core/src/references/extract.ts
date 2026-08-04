/**
 * PRD §19.1 / §19.5 — reference extraction.
 *
 * > "Walk a resolved document and yield every reference with its `OverlayPath`,
 * > target logical ID, and strong/weak classification" (plan §7).
 *
 * The walk is over a **resolved** document, never over an overlay record: §19.1's
 * core rule is that a parent is not rewritten when a target changes, so extraction
 * only ever reads.
 *
 * Object keys are visited in sorted order so the output is identical for two
 * documents that differ only in key insertion order — the same determinism rule
 * the canonical serializer applies (PRD §14.3, §34.17).
 */
import {isDraftId, toPublishedId} from '../encoding'
import type {SanityDocument} from '../types/document'
import type {OverlayPath, OverlayPathSegment} from '../types/path'
import {referenceRuleAt, type SerializedSchemaArtifact} from '../validation/schema'
import type {ExtractedReference, ReferenceStrength} from './types'

export interface ExtractReferencesOptions {
  /** PRD §20.1 artifact, used only for schema-declared weakness (§19.5). */
  schema?: SerializedSchemaArtifact
  /** Overrides `document._type` when the holding type is known independently. */
  typeName?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Is this value a Sanity reference node?
 *
 * A non-empty string `_ref` is the discriminator. `_type: 'reference'` is the
 * conventional companion but is not required — Content Lake accepts a bare
 * `{_ref}` inside a typed array member — so requiring it would silently drop
 * real references.
 */
export function isReferenceValue(value: unknown): value is {_ref: string; _weak?: boolean} {
  return isPlainObject(value) && typeof value._ref === 'string' && value._ref.length > 0
}

function segmentFor(item: unknown, index: number): OverlayPathSegment {
  return isPlainObject(item) && typeof item._key === 'string' ? {_key: item._key} : index
}

function classify(
  value: {_ref: string; _weak?: boolean},
  path: OverlayPath,
  options: ExtractReferencesOptions,
  typeName: string | undefined,
): {strength: ReferenceStrength; weakFromSchema: boolean} {
  // An explicit `_weak` on the value is authoritative: it is what Content Lake
  // stores and what a strengthen/weaken mutation writes.
  if (typeof value._weak === 'boolean') {
    return {strength: value._weak ? 'weak' : 'strong', weakFromSchema: false}
  }
  const rule = referenceRuleAt(options.schema, typeName, path)
  if (rule !== null && rule.weak) return {strength: 'weak', weakFromSchema: true}
  return {strength: 'strong', weakFromSchema: false}
}

/** Yield every reference in a resolved document (PRD §19.1). */
export function extractReferences(
  document: SanityDocument | null | undefined,
  options: ExtractReferencesOptions = {},
): ExtractedReference[] {
  if (document === null || document === undefined) return []
  const typeName = options.typeName ?? document._type
  const found: ExtractedReference[] = []

  const walk = (value: unknown, path: OverlayPath): void => {
    if (isReferenceValue(value)) {
      const {strength, weakFromSchema} = classify(value, path, options, typeName)
      found.push({
        path,
        rawRef: value._ref,
        targetId: toPublishedId(value._ref),
        targetVersion: isDraftId(value._ref) ? 'draft' : 'published',
        strength,
        ...(weakFromSchema ? {weakFromSchema: true as const} : {}),
      })
      // A reference node is a leaf: nothing inside it is content.
      return
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...path, segmentFor(item, index)]))
      return
    }

    if (isPlainObject(value)) {
      for (const key of Object.keys(value).sort()) {
        // `_`-prefixed keys are Sanity system fields, never content.
        if (key.startsWith('_')) continue
        walk(value[key], [...path, key])
      }
    }
  }

  walk(document, [])
  return found
}
