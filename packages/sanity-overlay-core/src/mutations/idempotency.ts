/**
 * A REPLAY IS ONLY A REPLAY IF IT IS THE SAME WRITE (PRD §13.10, §34.6).
 *
 * §34.6 says one idempotency key maps to one immutable transaction result, and
 * every layer implemented that as an unconditional lookup: present the key, get
 * the record, `replayed: true`. So a key that had been reused for a DIFFERENT
 * document answered with somebody else's transaction, and the caller was told
 * its write had already landed. Measured in a browser: a publish of an article
 * was answered `200 {"committed": false, "replayed": true}` carrying the
 * transaction id of a publish of an AUTHOR, and the article was never published.
 *
 * The ledger cannot check that two requests are equal — it stores a result, not
 * a request. But every stored record already names the documents its transaction
 * touched, and a transaction aimed at a document that record never touched is
 * PROVABLY not a replay of it. That is one set operation, it is free, and it
 * turns a fabricated success into a stated refusal.
 *
 * DELIBERATELY ONE-SIDED. The question asked is "does this request reach outside
 * what the stored transaction did?", not "are the two sets equal". A genuine
 * retry resends the same targets and passes. A caller that legitimately narrows
 * its scope on a retry — the same write, fewer records because the projection
 * moved on — also passes, because narrowing cannot cause the loss this guards
 * against: the danger is a write landing NOWHERE while being reported as saved,
 * and that requires a target the stored record never covered.
 */

/**
 * The incoming target ids the replayed transaction did not touch.
 *
 * Empty means the replay is consistent with the stored record and may be
 * returned. Non-empty means the key was reused for a different write.
 */
export function idempotencyReplayMismatch(
  replayedAffectedDocumentIds: readonly string[],
  targetDocumentIds: readonly string[],
): string[] {
  if (targetDocumentIds.length === 0) return []
  /* `Set` rather than `includes` in a loop: a §13.7 multi-document transaction
   * is unbounded in principle, and this runs on the hot commit path. */
  const affected = new Set(replayedAffectedDocumentIds)
  const outside: string[] = []
  for (const id of targetDocumentIds) {
    if (!affected.has(id) && !outside.includes(id)) outside.push(id)
  }
  return outside
}

/** The sentence both the store and the engine report, so they cannot drift. */
export function idempotencyReuseMessage(
  idempotencyKey: string,
  replayedTransactionId: string,
  replayedAffectedDocumentIds: readonly string[],
  outside: readonly string[],
): string {
  return (
    `Idempotency key ${JSON.stringify(idempotencyKey)} was already committed as transaction ` +
    `${JSON.stringify(replayedTransactionId)}, which touched ` +
    `${JSON.stringify([...replayedAffectedDocumentIds])} — but this request targets ` +
    `${JSON.stringify([...outside])}, which that transaction never touched. This is a REUSED ` +
    `key, not a retry: replaying it would report a write as already saved when nothing has ` +
    `been written for these documents (PRD §13.10, §34.6).`
  )
}
