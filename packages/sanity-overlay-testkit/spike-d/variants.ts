// SPIKE D branch-schema variants — one per §36.4 change, produced by
// deterministic mutation of the extracted base artifact.
import {type SchemaArtifact, clone} from './artifact'

const attr = (a: SchemaArtifact, typeName: string) => {
  const t = a.find((x) => x.name === typeName)
  if (!t?.attributes) throw new Error(`no document type ${typeName}`)
  return t.attributes
}

/** 1. Add optional field: article.subtitle (string). Compatible. */
export function addOptionalField(base: SchemaArtifact): SchemaArtifact {
  const a = clone(base)
  attr(a, 'article').subtitle = {type: 'objectAttribute', value: {type: 'string'}, optional: true}
  return a
}

/** 2. Add required field: article.summary. Existing docs must error visibly. */
export function addRequiredField(base: SchemaArtifact): SchemaArtifact {
  const a = clone(base)
  attr(a, 'article').summary = {type: 'objectAttribute', value: {type: 'string'}, optional: false}
  return a
}

/** 3. Rename field: article.title -> headline. Needs migration. */
export function renameField(base: SchemaArtifact): SchemaArtifact {
  const a = clone(base)
  const at = attr(a, 'article')
  at.headline = {...at.title}
  delete at.title
  return a
}

/** 4. Change scalar type: article.publishedAt string -> number. Incompatible. */
export function changeScalarType(base: SchemaArtifact): SchemaArtifact {
  const a = clone(base)
  attr(a, 'article').publishedAt = {type: 'objectAttribute', value: {type: 'number'}, optional: false}
  return a
}

/** 5. Change nested object shape: page.hero.cta.label -> .text. */
export function changeNestedShape(base: SchemaArtifact): SchemaArtifact {
  const a = clone(base)
  const hero = attr(a, 'page').hero.value
  const cta = hero.attributes?.cta.value
  if (!cta?.attributes) throw new Error('unexpected hero shape')
  cta.attributes.text = {...cta.attributes.label}
  delete cta.attributes.label
  return a
}

/** 6. Change reference targets: siteSettings.featuredArticle -> page only. */
export function changeReferenceTargets(base: SchemaArtifact): SchemaArtifact {
  const a = clone(base)
  attr(a, 'siteSettings').featuredArticle = {
    type: 'objectAttribute',
    value: {type: 'inline', name: 'page.reference'},
    optional: true,
  }
  return a
}

/** 7. Add new document type: event. Compatible; branch-created docs only. */
export function addDocumentType(base: SchemaArtifact): SchemaArtifact {
  const a = clone(base)
  a.push({
    type: 'document',
    name: 'event',
    attributes: {
      _id: {type: 'objectAttribute', value: {type: 'string'}},
      _type: {type: 'objectAttribute', value: {type: 'string', value: 'event'}},
      title: {type: 'objectAttribute', value: {type: 'string'}, optional: false},
      startsAt: {type: 'objectAttribute', value: {type: 'string'}, optional: true},
    },
  })
  return a
}

/** 8. Remove document type: page (and its reference helper). */
export function removeDocumentType(base: SchemaArtifact): SchemaArtifact {
  return clone(base).filter((t) => t.name !== 'page' && t.name !== 'page.reference')
}
