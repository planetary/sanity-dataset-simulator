import {execFileSync} from 'node:child_process'
import {X509Certificate} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * HTTPS material for the simulator. Browsers only speak HTTP/2 over TLS, and
 * Studio needs HTTP/2: it holds 8+ listen streams per open document, past
 * Chrome's 6-connections-per-host limit for HTTP/1.1 (Phase 0 finding).
 *
 * One local CA per machine (`~/.sanity-sim/ca/`), created on first run and
 * reused, so trusting it is a one-time step (`sanity-sim trust`). A leaf
 * certificate for localhost + `<projectId>.localhost` is minted from it as
 * needed. Uses the `openssl` CLI (present on macOS and most Linux).
 */
export function caDirectory() {
  return process.env.SANITY_SIM_HOME ? path.join(process.env.SANITY_SIM_HOME, 'ca') : path.join(os.homedir(), '.sanity-sim', 'ca')
}

/** Names the Node-side intercept certificate answers for (never trusted by the OS). */
export const INTERCEPT_NAMES = ['api.sanity.io', '*.api.sanity.io', '*.apicdn.sanity.io', 'cdn.sanity.io']

/**
 * Two CAs, two jobs:
 *
 * - `ca.pem` — the browser CA. Name-constrained to localhost names, so even
 *   once a user trusts it (`sanity-sim trust`) it can never vouch for any
 *   other site. Signs the leaf for `localhost` / `<project>.localhost`.
 * - `intercept-ca.pem` — handed ONLY to the dev processes sanity-sim starts
 *   (via NODE_EXTRA_CA_CERTS), never installed anywhere. Signs a leaf for
 *   Sanity's API hostnames, so `sanity-sim/register` can redirect a Node
 *   client's TLS connection to the simulator without the client noticing.
 */
export function ensureTls({hostnames}) {
  const dir = caDirectory()
  fs.mkdirSync(dir, {recursive: true, mode: 0o700})
  const browser = ensureCa(dir, 'ca', `sanity-sim local CA (${os.hostname().slice(0, 30)})`, [
    'nameConstraints=critical,permitted;DNS:localhost,permitted;DNS:.localhost,permitted;IP:127.0.0.0/255.0.0.0,permitted;IP:0:0:0:0:0:0:0:1/FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF',
  ])
  const intercept = ensureCa(dir, 'intercept-ca', `sanity-sim Node-only CA (do not trust)`, [])
  /*
   * Exact names only: Firefox (mozilla::pkix) rejects a wildcard over a single
   * label such as `*.localhost` as malformed when the issuer has name
   * constraints, failing the whole certificate with SEC_ERROR_BAD_DER.
   */
  let names = [...new Set(['localhost', ...hostnames])]
  const leaf = ensureLeaf(dir, 'leaf', browser, names, ['IP:127.0.0.1', 'IP:::1'])
  const interceptLeaf = ensureLeaf(dir, 'intercept-leaf', intercept, INTERCEPT_NAMES, [])
  const bundle = path.join(dir, 'node-ca-bundle.pem')
  fs.writeFileSync(bundle, Buffer.concat([fs.readFileSync(browser.cert), fs.readFileSync(intercept.cert)]))
  return {
    key: fs.readFileSync(leaf.key),
    cert: Buffer.concat([fs.readFileSync(leaf.cert), fs.readFileSync(browser.cert)]),
    intercept: {
      key: fs.readFileSync(interceptLeaf.key),
      cert: Buffer.concat([fs.readFileSync(interceptLeaf.cert), fs.readFileSync(intercept.cert)]),
    },
    caFile: browser.cert,
    nodeCaBundle: bundle,
    covers: (hostname) => names.includes(hostname),
    /**
     * Re-mint the browser leaf to also name `hostname` (a project the server
     * had not been told about, e.g. a workspace added while it runs).
     * Returns the new key and chain, which cover every earlier name too.
     */
    withHostname(hostname) {
      names = [...new Set([...names, hostname])]
      const next = ensureLeaf(dir, 'leaf', browser, names, ['IP:127.0.0.1', 'IP:::1'])
      return {key: fs.readFileSync(next.key), cert: Buffer.concat([fs.readFileSync(next.cert), fs.readFileSync(browser.cert)])}
    },
  }
}

function ensureCa(dir, name, commonName, extraExtensions) {
  const key = path.join(dir, `${name}-key.pem`)
  const cert = path.join(dir, `${name}.pem`)
  if (!fs.existsSync(cert) || !fs.existsSync(key)) {
    openssl([
      'req', '-x509', '-new', '-nodes',
      '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-keyout', key, '-out', cert, '-days', '3650',
      '-subj', `/CN=${commonName}/O=sanity-sim`,
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      ...extraExtensions.flatMap((extension) => ['-addext', extension]),
    ])
    fs.chmodSync(key, 0o600)
  }
  return {key, cert}
}

function ensureLeaf(dir, name, ca, dnsNames, ipNames) {
  const key = path.join(dir, `${name}-key.pem`)
  const cert = path.join(dir, `${name}.pem`)
  if (!leafCovers(cert, dnsNames, ca.cert)) {
    const csr = path.join(dir, `${name}.csr`)
    const ext = path.join(dir, `${name}.ext`)
    openssl(['req', '-new', '-nodes', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-keyout', key, '-out', csr, '-subj', `/CN=${dnsNames[0]}`])
    fs.writeFileSync(
      ext,
      [
        'basicConstraints=CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth',
        `subjectAltName=${[...dnsNames.map((dns) => `DNS:${dns}`), ...ipNames].join(',')}`,
      ].join('\n'),
    )
    openssl(['x509', '-req', '-in', csr, '-CA', ca.cert, '-CAkey', ca.key, '-CAcreateserial', '-out', cert, '-days', '397', '-sha256', '-extfile', ext])
    fs.chmodSync(key, 0o600)
    fs.rmSync(csr, {force: true})
  }
  return {key, cert}
}

function leafCovers(file, names, caFile) {
  if (!fs.existsSync(file)) return false
  try {
    const cert = new X509Certificate(fs.readFileSync(file))
    if (!cert.checkIssued(new X509Certificate(fs.readFileSync(caFile)))) return false
    if (new Date(cert.validTo).getTime() < Date.now() + 7 * 864e5) return false
    const dns = (cert.subjectAltName ?? '').split(', ').filter((entry) => entry.startsWith('DNS:')).map((entry) => entry.slice(4))
    /* Leaves from earlier versions carried `*.localhost`, which Firefox refuses. */
    if (dns.some((name) => name.startsWith('*.'))) return false
    return names.every((name) => dns.includes(name))
  } catch {
    return false
  }
}

function openssl(args) {
  try {
    execFileSync('openssl', args, {stdio: 'pipe'})
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('`openssl` is not on PATH, so no HTTPS certificate can be made. Install openssl, or run with --http (HTTP/1.1 only; Studio will stall past six listeners).')
    throw new Error(`openssl ${args[0]} failed: ${error.stderr?.toString() ?? error.message}`)
  }
}

/** Is the local CA already trusted by this machine? Best effort (macOS / NSS). */
export function isCaTrusted() {
  const caCert = path.join(caDirectory(), 'ca.pem')
  if (!fs.existsSync(caCert)) return false
  try {
    if (process.platform === 'darwin') execFileSync('security', ['verify-cert', '-c', caCert, '-p', 'ssl'], {stdio: 'pipe'})
    else if (process.platform === 'win32') execFileSync('certutil', ['-user', '-verifystore', 'Root', new X509Certificate(fs.readFileSync(caCert)).serialNumber], {stdio: 'pipe'})
    else execFileSync('certutil', ['-d', `sql:${path.join(os.homedir(), '.pki/nssdb')}`, '-L', '-n', TRUST_NICKNAME], {stdio: 'pipe'})
    return true
  } catch {
    return false
  }
}

const TRUST_NICKNAME = 'sanity-sim local CA'

/** Set when the user cancelled the OS trust dialog, or the OS refused (managed machines), so first runs stop re-asking. */
const declinedFile = () => path.join(caDirectory(), 'trust-declined')
export const trustDeclined = () => fs.existsSync(declinedFile())
export function setTrustDeclined(declined) {
  if (declined) fs.writeFileSync(declinedFile(), `${new Date().toISOString()}\n`)
  else fs.rmSync(declinedFile(), {force: true})
}

/**
 * The command that trusts the CA for this user (no admin rights needed). The
 * OS asks for confirmation itself: the keychain password dialog on macOS, a
 * security warning on Windows. Linux trusts it for Chrome's NSS store.
 */
export function trustCommand() {
  const caCert = path.join(caDirectory(), 'ca.pem')
  if (process.platform === 'darwin') {
    return ['security', ['add-trusted-cert', '-r', 'trustRoot', '-k', path.join(os.homedir(), 'Library/Keychains/login.keychain-db'), caCert]]
  }
  if (process.platform === 'win32') return ['certutil', ['-user', '-addstore', 'Root', caCert]]
  return ['certutil', ['-d', `sql:${path.join(os.homedir(), '.pki/nssdb')}`, '-A', '-t', 'C,,', '-n', TRUST_NICKNAME, '-i', caCert]]
}
