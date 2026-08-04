# Spike D report — schema branch compatibility (PRD §36.4)

**Date:** 2026-08-03 · **Status: PASS** · **Attempts used:** 1 fixture pass (bound: 1 + 1 migration repair, §36.0) · **Deviation:** working tree, not an isolated spike branch (repo predates first commit; waiver as Spike C).

## Deliverables (§36.0)

| Artifact | Location |
|---|---|
| Compatibility matrix | The eight §36.4 changes below, each with observed behavior |
| Validation report | `test/spike-d-schema.test.ts` — 12 tests green (145/145 suite-wide) |

## Method

- **Schema artifact:** `sanity schema extract --enforce-required-fields` from the kitchen-sink schema — this validates the v1.1 §10.1/§20.1 schema-artifact-injection mandate against the real toolchain. Artifact encodes required-ness (`optional: false`) and reference targets (`dereferencesTo`).
- **Branch variants:** deterministic artifact mutations (`spike-d/variants.ts`), one per §36.4 change.
- **Scanner prototype:** `spike-d/scanner.ts` produces §20.3 findings (`UNKNOWN_TYPE`, `MISSING_REQUIRED_FIELD`, `TYPE_MISMATCH`, `INVALID_ARRAY_MEMBER`, `DISALLOWED_REFERENCE_TARGET`, `UNKNOWN_FIELD`) over the resolved fixture documents.
- **Migration:** rename modeled as PRD §20.4 `OverlayMigration` carrying §13.7 `OverlayMutation` envelopes; applied overlay-side only.

## Compatibility matrix (observed vs §20.2 expected)

| §36.4 change | Observed | Matches §20.2 |
|---|---|---|
| Add optional field | Zero findings; base docs valid | ✅ |
| Add required field | 30 hard `MISSING_REQUIRED_FIELD` — visible until populated | ✅ |
| Rename field (with migration) | Fails before migration (missing `headline` + orphaned `title`); zero findings after; every `headline` equals original `title` | ✅ explicit migration path |
| Change scalar type | 30 hard `TYPE_MISMATCH` | ✅ |
| Change nested object shape | Flagged at nested path `hero.cta.label` | ✅ |
| Change reference target types | `DISALLOWED_REFERENCE_TARGET` on `siteSettings.featuredArticle` | ✅ |
| Add document type | Base unaffected; branch-created doc validates; invalid one errors | ✅ |
| Remove document type | 3 base pages → hard `UNKNOWN_TYPE`, policy required | ✅ |

## Pass criteria (§36.4)

- [x] Compatible changes work normally.
- [x] Incompatible changes fail visibly (hard findings with document + path).
- [x] No base data is lost — byte-identical base snapshot asserted after all scans + migration.
- [x] Migration path is explicit (§20.4 plan, §13.7 mutations, per-document operations).

## Test-quality remediation (2026-08-04, mutation-driven)

A mutation audit confirmed all six finding codes have live detection (each scanner mutation killed 1–3 tests), but found the consequential bug class was **unguarded: severity**. A finding emitted at the *wrong severity* silently converts a branch-blocking error into an advisory one.

| Surviving mutation | Meaning | Fix |
|---|---|---|
| `TYPE_MISMATCH` severity hard → soft | Incompatible scalar types would stop blocking | Explicit hard-severity assertions |
| `DISALLOWED_REFERENCE_TARGET` hard → soft | Invalid reference targets would stop blocking | Explicit hard-severity assertions |
| `INVALID_ARRAY_MEMBER` never emitted | **Dead code** — declared, implemented, never exercised by any §36.4 variant | New variant (`article.tags` string → number) that triggers it |

Plus a whole-corpus invariant asserting every emitted code carries its documented severity **and** that all six codes are reachable. Each proven red under its mutation (2 failures each), then green.

**Assessment after remediation:** moderately trustworthy. Detection is real but thin — most mutants die by exactly one test, so there is no redundancy against a careless edit.

## Caveats

1. Scanner is spike-grade: unions and Portable Text internals validated shallowly; `sanity.imageAsset` chain untested (no assets in fixture, D01 default).
2. Requiredness needs the `--enforce-required-fields` extract flag — without it everything is optional. Record as a Phase 2 validator-port requirement.
3. Spike applier handles top-level paths only; real path semantics (keyed arrays) are Phase 2 (§13.6).
