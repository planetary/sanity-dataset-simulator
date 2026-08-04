// SPIKE D (PRD §36.4): serialized schema artifact access.
// The artifact is produced by `sanity schema extract --enforce-required-fields`
// — the injection mechanism mandated by PRD §10.1/§20.1 (v1.1), proven here
// against the real toolchain.
import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

export interface ArtifactValue {
  type: string // 'string' | 'number' | 'boolean' | 'array' | 'object' | 'inline' | 'union' | ...
  value?: unknown // literal for const strings
  name?: string // for 'inline'
  of?: ArtifactValue | ArtifactValue[] // for 'array' / 'union'
  attributes?: Record<string, ArtifactAttribute> // for 'object'
  dereferencesTo?: string
}

export interface ArtifactAttribute {
  type: 'objectAttribute'
  value: ArtifactValue
  optional?: boolean
}

export interface ArtifactType {
  type: 'type' | 'document'
  name: string
  attributes?: Record<string, ArtifactAttribute> // document form
  value?: ArtifactValue // named-type form
}

export type SchemaArtifact = ArtifactType[]

const BASE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'base-schema.json')

export function loadBaseArtifact(): SchemaArtifact {
  return JSON.parse(readFileSync(BASE_PATH, 'utf8')) as SchemaArtifact
}

export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

export function documentTypes(artifact: SchemaArtifact): Map<string, ArtifactType> {
  return new Map(artifact.filter((t) => t.type === 'document').map((t) => [t.name, t]))
}

/** Resolve 'inline' indirection to the underlying value. */
export function resolveValue(artifact: SchemaArtifact, v: ArtifactValue): ArtifactValue {
  if (v.type === 'inline' && v.name) {
    const named = artifact.find((t) => t.name === v.name)
    if (named?.value) return resolveValue(artifact, named.value)
  }
  return v
}
