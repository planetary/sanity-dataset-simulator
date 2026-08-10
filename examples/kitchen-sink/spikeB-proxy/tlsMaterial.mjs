/**
 * THE CERTIFICATE THE h2 LISTENER NEEDS — and the one manual step nobody can
 * take away.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS A CERTIFICATE HERE AT ALL
 *
 * Chromium allows six concurrent HTTP/1.1 connections per origin, and
 * `sanity@6.8.0` holds six long-lived listener streams open against the data
 * host. The seventh request — the document pair's initial snapshot — is queued
 * and never issued, so `editState` never becomes ready and no keystroke can be
 * typed. Content Lake is HTTP/2, where those six are six streams on one
 * connection; a stand-in that speaks HTTP/1.1 imposes a ceiling the real
 * service does not have.
 *
 * Browsers negotiate HTTP/2 over TLS and ALPN only — there is no h2c in any
 * browser, and Chromium's `--max-connections-per-host` does not move the
 * HTTP/1.1 budget (measured, both ways). So h2 means TLS, and TLS means a
 * certificate for the name `@sanity/client` actually asks for, which is
 * `<projectId>.localhost` — a WILDCARD name, not `localhost`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LADDER, AND WHY IT IS A LADDER
 *
 *   1. explicit    PROXY_TLS_CERT / PROXY_TLS_KEY. Someone with a corporate CA,
 *                  a shared dev certificate, or a reverse proxy in front knows
 *                  more than this file does; nothing is minted.
 *   2. mkcert      A LOCALLY-TRUSTED certificate. This is the only rung with no
 *                  interstitial and no `ignoreHTTPSErrors`, because mkcert's
 *                  root is in the OS (and NSS) trust store.
 *   3. self-signed `openssl req -x509`. Works, but the browser does not trust
 *                  it, and — this is the part that matters — a cross-origin
 *                  request from `http://localhost:3333` to an untrusted-cert
 *                  origin FAILS WITH NO INTERSTITIAL TO CLICK. You have to
 *                  visit `https://<projectId>.localhost:<port>` in a tab and
 *                  accept it there once, or trust the file.
 *   4. none        Neither tool is present. This is reported as a refusal, not
 *                  papered over: a proxy that quietly served HTTP/1.1 only
 *                  would start, look healthy, and be unusable in a browser at
 *                  the seventh request — which is the exact defect the h2
 *                  listener exists to remove.
 *
 * `mkcert -install` IS NOT RUN FOR YOU. It writes to the system trust store and
 * to Firefox's NSS database and it prompts for a password; a proxy that did
 * that unasked would be doing something no one typed. It is reported as
 * `manualStep` instead, and the CLI prints it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SHAPE OF THIS MODULE
 *
 * {@link planTlsMaterial} is a PURE DECISION over booleans — which rung, and
 * what the developer still has to do. It is the part with the interesting
 * behaviour, and it is testable without touching the machine, the network or
 * anyone's keychain. {@link probeTlsTooling} is the impure half that answers
 * those booleans, and {@link ensureTlsMaterial} is the one function that writes
 * files.
 */
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'
import process from 'node:process'

/**
 * The names every certificate this module produces must cover.
 *
 * `@sanity/client` builds `<projectId>.<apiHost host>`, so the name the browser
 * asks for is `b1n03q3z.localhost` and a certificate for bare `localhost` is
 * refused before a byte of HTTP is exchanged.
 *
 * BOTH THE WILDCARD AND THE EXACT NAME, and the exact name is the one that
 * matters. `*.localhost` is a wildcard whose parent is a single label, and that
 * is precisely the shape verifiers refuse: OpenSSL's `X509_check_host` declines
 * it even with `X509_CHECK_FLAG_SINGLE_LABEL_SUBDOMAINS` (measured — see
 * `proxy-h2.test.ts`, which asserts the exact name matches and would have
 * passed vacuously on the wildcard alone), and Chromium applies a rule of the
 * same family. So the project's own host is named explicitly and the wildcard
 * is kept only as a convenience for whoever has a verifier that honours it.
 *
 * @param {string[]} [extra] concrete hostnames, e.g. `b1n03q3z.localhost`
 */
export function certificateNames(extra = []) {
  const names = ['localhost', '*.localhost', ...extra, '127.0.0.1', '::1']
  return [...new Set(names.filter(Boolean))]
}

/** How long a minted certificate is good for. Long enough for a project, short
 * enough that a leaked dev key is not a durable credential. */
const VALID_DAYS = 90

/**
 * Decide which rung of the ladder applies.
 *
 * Every input is a fact about the machine, supplied by the caller, so this
 * function has no side effects and no opinions it cannot justify from its
 * arguments.
 *
 * @param {{
 *   explicit?: {certPath?: string, keyPath?: string} | null,
 *   hasMkcert?: boolean,
 *   mkcertInstalled?: boolean | 'unknown',
 *   hasOpenssl?: boolean,
 *   force?: 'explicit'|'mkcert'|'self-signed'|'auto',
 * }} facts
 * @returns {{
 *   source: 'explicit'|'mkcert'|'self-signed'|'none',
 *   trusted: 'yes'|'no'|'unknown'|'assumed',
 *   manualStep: string|null,
 *   reason: string,
 * }}
 */
export function planTlsMaterial(facts = {}) {
  const {
    explicit = null,
    hasMkcert = false,
    mkcertInstalled = false,
    hasOpenssl = false,
    force = 'auto',
  } = facts

  const wants = (rung) => force === 'auto' || force === rung

  if (explicit && explicit.certPath && explicit.keyPath && wants('explicit')) {
    return {
      source: 'explicit',
      /* We did not issue it and cannot see the trust store it may be in. The
       * caller named these files on purpose, so the trust question is theirs;
       * saying `yes` here would be inventing an answer. */
      trusted: 'assumed',
      manualStep: null,
      reason: 'PROXY_TLS_CERT / PROXY_TLS_KEY were supplied',
    }
  }

  if (hasMkcert && wants('mkcert')) {
    if (mkcertInstalled === true) {
      return {
        source: 'mkcert',
        trusted: 'yes',
        manualStep: null,
        reason: 'mkcert is installed and its root is in the trust store',
      }
    }
    return {
      source: 'mkcert',
      trusted: mkcertInstalled === 'unknown' ? 'unknown' : 'no',
      manualStep:
        'run `mkcert -install` once (it asks for your password, and adds mkcert’s ' +
        'root to the system and Firefox trust stores). Without it the browser ' +
        'refuses this certificate, and a cross-origin request has no interstitial to click.',
      reason:
        mkcertInstalled === 'unknown'
          ? 'mkcert is present; whether its root is trusted could not be determined on this platform'
          : 'mkcert is present but its root has not been added to the trust store',
    }
  }

  if (hasOpenssl && wants('self-signed')) {
    return {
      source: 'self-signed',
      trusted: 'no',
      manualStep:
        `open https://<projectId>.localhost:<port>${''} in the browser once and accept the ` +
        'certificate — a CROSS-ORIGIN request to an untrusted-certificate origin fails ' +
        'silently, with no interstitial. Installing `mkcert` and running `mkcert -install` ' +
        'removes this step for good.',
      reason: 'no mkcert on PATH; minted a self-signed certificate with openssl',
    }
  }

  return {
    source: 'none',
    trusted: 'no',
    manualStep:
      'install `mkcert` (recommended: `brew install mkcert && mkcert -install`) or `openssl`, ' +
      'or point PROXY_TLS_CERT / PROXY_TLS_KEY at a certificate you already have. ' +
      'To run without a browser-usable listener, set PROXY_TLS=0 — but read what that costs ' +
      'in spikeB-proxy/README.md first.',
    reason:
      'neither mkcert nor openssl is on PATH, so no certificate could be produced ' +
      'and the HTTP/2 listener cannot start',
  }
}

/** Is `command` runnable? */
function onPath(command, args = ['--version']) {
  try {
    execFileSync(command, args, {stdio: 'ignore'})
    return true
  } catch {
    return false
  }
}

/**
 * Is mkcert's root actually in this machine's trust store?
 *
 * mkcert has no "am I installed" query, and the presence of `rootCA.pem` proves
 * only that a CA was GENERATED — issuing any certificate creates it, installed
 * or not. On macOS the store can be asked directly. Everywhere else this
 * returns `'unknown'` rather than guessing, and `planTlsMaterial` reports the
 * uncertainty instead of resolving it in the comfortable direction.
 */
function mkcertRootInstalled() {
  let caRoot = ''
  try {
    caRoot = String(execFileSync('mkcert', ['-CAROOT'], {encoding: 'utf8'})).trim()
  } catch {
    return false
  }
  const rootPem = join(caRoot, 'rootCA.pem')
  if (!caRoot || !existsSync(rootPem)) return false
  if (process.platform !== 'darwin') return 'unknown'
  try {
    execFileSync('security', ['verify-cert', '-c', rootPem], {stdio: 'ignore'})
    return true
  } catch {
    return false
  }
}

/** The facts {@link planTlsMaterial} needs, read off this machine. */
export function probeTlsTooling() {
  const hasMkcert = onPath('mkcert', ['-CAROOT'])
  return {
    hasMkcert,
    mkcertInstalled: hasMkcert ? mkcertRootInstalled() : false,
    hasOpenssl: onPath('openssl', ['version']),
  }
}

/** Certificate files that exist and are not obviously stale. */
function usable(certPath, keyPath) {
  if (!existsSync(certPath) || !existsSync(keyPath)) return false
  try {
    /* A zero-length file is what a killed `openssl` leaves behind, and it
     * produces an incomprehensible TLS error several seconds later. */
    return statSync(certPath).size > 0 && statSync(keyPath).size > 0
  } catch {
    return false
  }
}

function mintWithMkcert(certPath, keyPath, names) {
  execFileSync('mkcert', ['-key-file', keyPath, '-cert-file', certPath, ...names], {
    stdio: 'ignore',
  })
}

function mintWithOpenssl(certPath, keyPath, names) {
  const sans = names.map((name) =>
    name === '127.0.0.1' ? 'IP:127.0.0.1' : name === '::1' ? 'IP:::1' : `DNS:${name}`,
  ).join(',')
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', String(VALID_DAYS),
      '-subj', '/CN=localhost',
      '-addext', `subjectAltName=${sans}`,
    ],
    {stdio: 'ignore'},
  )
}

/**
 * Produce the key and certificate the h2 listener will present.
 *
 * Throws — loudly, with the ladder's own `reason` and `manualStep` in the
 * message — when nothing can be produced. The caller must NOT catch that and
 * fall back to HTTP/1.1: a listener that silently is not there is the defect,
 * not the remedy.
 *
 * @param {{dir: string, certPath?: string, keyPath?: string, names?: string[],
 *          source?: 'auto'|'explicit'|'mkcert'|'self-signed', probe?: object}} options
 */
export function ensureTlsMaterial({dir, certPath, keyPath, names, source = 'auto', probe} = {}) {
  const facts = probe ?? probeTlsTooling()
  const plan = planTlsMaterial({
    ...facts,
    explicit: certPath && keyPath ? {certPath, keyPath} : null,
    force: source,
  })

  if (plan.source === 'none') {
    throw new Error(
      `[proxy] the HTTP/2 listener needs a TLS certificate and none could be produced: ${plan.reason}\n` +
        `[proxy] what to do: ${plan.manualStep}`,
    )
  }

  if (plan.source === 'explicit') {
    return {
      ...plan,
      certPath,
      keyPath,
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
    }
  }

  mkdirSync(dir, {recursive: true})
  const subjects = certificateNames(names)
  /* The names are IN THE FILENAME. A cached certificate that covers a different
   * project's host is not a cache hit, and reusing it would fail in the browser
   * with an error that points at TLS rather than at the stale file. */
  const stamp = createHash('sha256').update(subjects.join(',')).digest('hex').slice(0, 8)
  const outCert = join(dir, `proxy-${plan.source}-${stamp}-cert.pem`)
  const outKey = join(dir, `proxy-${plan.source}-${stamp}-key.pem`)

  if (!usable(outCert, outKey)) {
    try {
      if (plan.source === 'mkcert') mintWithMkcert(outCert, outKey, subjects)
      else mintWithOpenssl(outCert, outKey, subjects)
    } catch (error) {
      throw new Error(
        `[proxy] minting a *.localhost certificate with ${plan.source} failed: ` +
          `${String(error?.message ?? error)}\n[proxy] what to do: ${plan.manualStep}`,
      )
    }
  }

  return {
    ...plan,
    /* The names really in the certificate, so a caller can print the URL a
     * developer has to visit rather than a `<projectId>` placeholder. */
    names: subjects,
    certPath: outCert,
    keyPath: outKey,
    cert: readFileSync(outCert),
    key: readFileSync(outKey),
  }
}

/**
 * The concrete URL a developer must visit once to accept an untrusted
 * certificate — the placeholder in `manualStep`, filled in.
 *
 * A cross-origin request to an untrusted-certificate origin fails with NO
 * interstitial, so "just click through" is not advice that works; the origin
 * has to be visited directly, in a tab, first.
 */
export function trustVisitUrl(material, port) {
  const name = (material?.names ?? []).find(
    (candidate) => candidate.endsWith('.localhost') && !candidate.startsWith('*'),
  )
  return name ? `https://${name}:${port}/` : null
}

/** One line for the startup banner, honest about what is still owed. */
export function describeTlsMaterial(material) {
  const trust =
    material.trusted === 'yes'
      ? 'locally trusted'
      : material.trusted === 'assumed'
        ? 'supplied by you'
        : material.trusted === 'unknown'
          ? 'trust UNVERIFIED on this platform'
          : 'NOT TRUSTED by the browser'
  return `${material.source} certificate (${trust}) — ${material.certPath}`
}
