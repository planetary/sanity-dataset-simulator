# Sanity branch overlay

This directory is the canonical, review-facing state of a Sanity branch overlay
(PRD section 14.1).

- `manifest.json` — overlay identity, lifecycle state, revision and document heads.
- `documents/<encoded-id>/intent.json` — the file an agent edits and a reviewer reads.
- `snapshots/<sha256>.json` — immutable base captures, kept for deletion recovery
  and three-way merge. Generated recovery artifacts, not a review surface.
- `.runtime/` — generated materialized documents, the transaction log and local
  runtime history. Not committed.

Edit `intent.json` directly if you want; the store revalidates, recomputes
checksums and refuses malformed JSON while retaining the last valid state.
