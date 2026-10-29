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

export function ensureTls({hostnames}) {
  const dir = caDirectory()
  fs.mkdirSync(dir, {recursive: true, mode: 0o700})
  const caKey = path.join(dir, 'ca-key.pem')
  const caCert = path.join(dir, 'ca.pem')
  if (!fs.existsSync(caCert) || !fs.existsSync(caKey)) {
    openssl([
      'req', '-x509', '-new', '-nodes',
      '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-keyout', caKey, '-out', caCert, '-days', '3650',
      '-subj', `/CN=sanity-sim local CA (${os.hostname()})/O=sanity-sim`,
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    ])
    fs.chmodSync(caKey, 0o600)
  }

  const names = [...new Set(['localhost', '*.localhost', ...hostnames])]
  const leafKey = path.join(dir, 'leaf-key.pem')
  const leafCert = path.join(dir, 'leaf.pem')
  if (!leafCovers(leafCert, names)) {
    const csr = path.join(dir, 'leaf.csr')
    const ext = path.join(dir, 'leaf.ext')
    openssl(['req', '-new', '-nodes', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-keyout', leafKey, '-out', csr, '-subj', '/CN=localhost'])
    fs.writeFileSync(
      ext,
      [
        'basicConstraints=CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth',
        `subjectAltName=${[...names.map((name) => `DNS:${name}`), 'IP:127.0.0.1', 'IP:::1'].join(',')}`,
      ].join('\n'),
    )
    openssl(['x509', '-req', '-in', csr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-out', leafCert, '-days', '397', '-sha256', '-extfile', ext])
    fs.chmodSync(leafKey, 0o600)
    fs.rmSync(csr, {force: true})
  }
  return {
    key: fs.readFileSync(leafKey),
    cert: Buffer.concat([fs.readFileSync(leafCert), fs.readFileSync(caCert)]),
    caFile: caCert,
  }
}

function leafCovers(file, names) {
  if (!fs.existsSync(file)) return false
  try {
    const cert = new X509Certificate(fs.readFileSync(file))
    if (new Date(cert.validTo).getTime() < Date.now() + 7 * 864e5) return false
    const san = cert.subjectAltName ?? ''
    return names.every((name) => san.includes(`DNS:${name}`))
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
    if (process.platform === 'darwin') {
      execFileSync('security', ['verify-cert', '-c', caCert, '-p', 'ssl'], {stdio: 'pipe'})
      return true
    }
  } catch {
    return false
  }
  return false
}

/**
 * The command that trusts the CA for this user. Never run silently: changing
 * trust settings is the user's decision, so the CLI prints it or runs it only
 * from `sanity-sim trust` (which asks for confirmation through the OS).
 */
export function trustCommand() {
  const caCert = path.join(caDirectory(), 'ca.pem')
  if (process.platform === 'darwin') {
    return ['security', ['add-trusted-cert', '-r', 'trustRoot', '-k', path.join(os.homedir(), 'Library/Keychains/login.keychain-db'), caCert]]
  }
  if (process.platform === 'win32') return ['certutil', ['-user', '-addstore', 'Root', caCert]]
  return ['certutil', ['-d', `sql:${path.join(os.homedir(), '.pki/nssdb')}`, '-A', '-t', 'C,,', '-n', 'sanity-sim local CA', '-i', caCert]]
}
