/**
 * The serialized schema artifact core is given (PRD §20.1).
 *
 * > "[MUST] Extract a serialized schema artifact from branch schema code so
 * > server-side and core validation (sections 9.1 and 17.3) run without importing
 * > Studio."
 *
 * Core therefore never imports Studio, `sanity`, or `@sanity/types` (plan §3,
 * PRD §10.1). It reads this structural, JSON-shaped description and nothing else.
 * Extraction of the artifact from branch schema code belongs to the Studio-side
 * package in a later phase; the shape below is the contract between them.
 */
import type {OverlayPath, OverlayPathSegment} from '../types/path'
import {isKeySegment} from '../types/path'

/**
 * One field or array member in the artifact.
 *
 * Array members carry no `name`, which is why `name` is optional: the same shape
 * describes `fields[]` entries and `of[]` entries so path resolution can walk
 * both with one function.
 */
export interface SerializedSchemaField {
  name?: string
  /** Schema type name: a primitive (`string`), `reference`, `array`, or a named object type. */
  type: string
  title?: string
  /** PRD §20.2 "Add required field". */
  required?: boolean
  /** PRD §19.5 — weak references may target missing or draft-only documents. */
  weak?: boolean
  /** PRD §19.7 — allowed reference target types. */
  to?: readonly string[]
  of?: readonly SerializedSchemaField[]
  fields?: readonly SerializedSchemaField[]
}

export interface SerializedSchemaType {
  name: string
  type?: string
  fields?: readonly SerializedSchemaField[]
  of?: readonly SerializedSchemaField[]
}

export interface SerializedSchemaArtifact {
  /** PRD §20.1 "[MUST] Store schema commit SHA in the overlay manifest". */
  schemaCommit: string
  types: readonly SerializedSchemaType[]
}

/** An empty artifact: every type unknown, no field rules. */
export const EMPTY_SCHEMA_ARTIFACT: SerializedSchemaArtifact = Object.freeze({
  schemaCommit: '',
  types: Object.freeze([]) as readonly SerializedSchemaType[],
})

/** Look a document type up by name. */
export function getSchemaType(
  schema: SerializedSchemaArtifact | undefined,
  name: string | undefined,
): SerializedSchemaType | null {
  if (schema === undefined || name === undefined) return null
  return schema.types.find((type) => type.name === name) ?? null
}

function fieldsOf(
  schema: SerializedSchemaArtifact,
  definition: SerializedSchemaField | SerializedSchemaType | null,
): readonly SerializedSchemaField[] | null {
  if (definition === null) return null
  if (definition.fields !== undefined) return definition.fields
  const named = getSchemaType(schema, (definition as SerializedSchemaField).type)
  return named?.fields ?? null
}

function membersOf(
  schema: SerializedSchemaArtifact,
  definition: SerializedSchemaField | SerializedSchemaType | null,
): readonly SerializedSchemaField[] | null {
  if (definition === null) return null
  if (definition.of !== undefined) return definition.of
  const named = getSchemaType(schema, (definition as SerializedSchemaField).type)
  return named?.of ?? null
}

/**
 * Collapse the members of an array into one definition for path resolution.
 *
 * An array with several member types cannot be narrowed by path alone — the
 * concrete item's `_type` would be needed — so reference members are merged:
 * `to` becomes the union of every member's allowed types, and the merged member
 * is weak only when **every** reference member is weak. That errs on the side of
 * "strong", which is the safe direction for delete and publish blocking.
 */
function mergeArrayMembers(members: readonly SerializedSchemaField[]): SerializedSchemaField | null {
  if (members.length === 0) return null
  if (members.length === 1) return members[0] ?? null

  const references = members.filter((member) => member.type === 'reference')
  if (references.length === 0) return members[0] ?? null

  const to: string[] = []
  for (const member of references) {
    for (const name of member.to ?? []) if (!to.includes(name)) to.push(name)
  }
  return {
    type: 'reference',
    weak: references.every((member) => member.weak === true),
    to,
  }
}

function isContainerSegment(segment: OverlayPathSegment): boolean {
  return isKeySegment(segment) || typeof segment === 'number'
}

/**
 * Resolve the artifact definition addressed by an {@link OverlayPath}.
 *
 * Returns `null` when the artifact has nothing to say about the path — an unknown
 * type, an unknown field, or a path through a schemaless value. Callers must
 * treat `null` as "no rule", never as "rule violated".
 */
export function resolveFieldDefinition(
  schema: SerializedSchemaArtifact | undefined,
  typeName: string | undefined,
  path: OverlayPath,
): SerializedSchemaField | null {
  if (schema === undefined) return null
  const root = getSchemaType(schema, typeName)
  if (root === null) return null

  let current: SerializedSchemaField | SerializedSchemaType | null = root
  for (const segment of path) {
    if (current === null) return null
    if (isContainerSegment(segment)) {
      const members = membersOf(schema, current)
      if (members === null) return null
      current = mergeArrayMembers(members)
      continue
    }
    const fields = fieldsOf(schema, current)
    if (fields === null) return null
    current = fields.find((field) => field.name === segment) ?? null
  }

  return current === null || current === root ? null : (current as SerializedSchemaField)
}

/** The reference rule that applies at a path, or `null` when the artifact has none. */
export function referenceRuleAt(
  schema: SerializedSchemaArtifact | undefined,
  typeName: string | undefined,
  path: OverlayPath,
): {weak: boolean; to: string[]} | null {
  const definition = resolveFieldDefinition(schema, typeName, path)
  if (definition === null) return null
  if (definition.type !== 'reference') return null
  return {weak: definition.weak === true, to: [...(definition.to ?? [])]}
}
