/**
 * Secret hygiene — PRD §5.5 / §26: the CLI must never print a token.
 *
 * The CLI does not read credentials, so in principle it has none to leak. That
 * is exactly why this exists: "we do not handle tokens" is a property of today's
 * code, and a future command that reads `SANITY_API_TOKEN` to talk to the base
 * dataset would otherwise start echoing it into a diff or an error the moment
 * the value appears in a document field or a stack trace.
 *
 * The filter runs on every byte the CLI writes to either stream, keyed off the
 * *environment* rather than off content heuristics: only values the process was
 * actually given are masked, so ordinary document content is never mangled by a
 * pattern that merely looks secret.
 */

/** Environment variable names whose value is treated as a credential. */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSPHRASE|API_?KEY|CREDENTIAL|PRIVATE_KEY|_AUTH)/i

/**
 * Below this length a value is too short to be a credential and too likely to
 * be a common substring (`dev`, `1234`) that masking it would corrupt output.
 */
const MIN_SECRET_LENGTH = 8

export const REDACTED = '«redacted»'

/** Credential values present in this environment, longest first. */
export function collectSecrets(
  env: Readonly<Record<string, string | undefined>> = {},
): readonly string[] {
  const secrets = new Set<string>()
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) continue
    if (!SECRET_NAME.test(name)) continue
    secrets.add(value)
  }
  /* Longest first, so a secret that contains another is masked whole. */
  return [...secrets].sort((a, b) => b.length - a.length)
}

/** Replace every occurrence of every collected secret. */
export function redact(text: string, secrets: readonly string[]): string {
  if (secrets.length === 0) return text
  let out = text
  for (const secret of secrets) {
    if (!out.includes(secret)) continue
    out = out.split(secret).join(REDACTED)
  }
  return out
}
