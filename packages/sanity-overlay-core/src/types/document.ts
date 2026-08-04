/**
 * Minimal structural `SanityDocument` shape.
 *
 * PRD §13.4 (`snapshot: SanityDocument`), §13.5 (`materialized: SanityDocument`)
 * and §13.7 (`replaceDocument`, `create*`) define core types in terms of a Sanity
 * document. Plan §3 permits type-only knowledge of Sanity documents but forbids a
 * runtime `@sanity/client` import, so the shape is declared structurally here and
 * stays assignable from `@sanity/types`' `SanityDocument`.
 */
export interface SanityDocument {
  _id: string
  _type: string
  _rev?: string
  _createdAt?: string
  _updatedAt?: string
  [key: string]: unknown
}
