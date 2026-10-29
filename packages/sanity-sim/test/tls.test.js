import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {X509Certificate} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {before, describe, it} from 'node:test'
import {ensureTls} from '../src/tls.js'

describe('browser certificate', () => {
  let leaf
  let dir
  before(() => {
    process.env.SANITY_SIM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sanity-sim-home-'))
    dir = path.join(process.env.SANITY_SIM_HOME, 'ca')
    ensureTls({hostnames: ['proj1.localhost']})
    leaf = new X509Certificate(fs.readFileSync(path.join(dir, 'leaf.pem')))
  })

  /*
   * Firefox (mozilla::pkix) checks every SAN against the CA's name constraints
   * and rejects a wildcard over a single label (`*.localhost`) as malformed:
   * SEC_ERROR_BAD_DER, for the whole certificate.
   */
  it('names only DNS ids that mozilla::pkix accepts', () => {
    const dns = leaf.subjectAltName.split(', ').filter((entry) => entry.startsWith('DNS:')).map((entry) => entry.slice(4))
    for (const name of dns) {
      if (!name.startsWith('*.')) continue
      assert.ok(name.slice(2).split('.').length >= 2, `${name} is a wildcard over a single label`)
    }
    assert.ok(dns.includes('localhost'))
    assert.ok(dns.includes('proj1.localhost'))
  })

  it('re-mints a leaf issued with the old single-label wildcard', () => {
    /* The leaf a previous version left in ~/.sanity-sim/ca still covers every name, so plain reuse would keep it. */
    const ext = path.join(dir, 'old.ext')
    fs.writeFileSync(ext, 'subjectAltName=DNS:localhost,DNS:*.localhost,DNS:proj1.localhost\n')
    execFileSync('openssl', ['req', '-new', '-key', path.join(dir, 'leaf-key.pem'), '-subj', '/CN=localhost', '-out', path.join(dir, 'old.csr')])
    execFileSync('openssl', ['x509', '-req', '-in', path.join(dir, 'old.csr'), '-CA', path.join(dir, 'ca.pem'), '-CAkey', path.join(dir, 'ca-key.pem'), '-CAcreateserial', '-days', '30', '-extfile', ext, '-out', path.join(dir, 'leaf.pem')], {stdio: 'pipe'})
    assert.match(new X509Certificate(fs.readFileSync(path.join(dir, 'leaf.pem'))).subjectAltName, /\*\.localhost/)

    ensureTls({hostnames: ['proj1.localhost']})
    assert.doesNotMatch(new X509Certificate(fs.readFileSync(path.join(dir, 'leaf.pem'))).subjectAltName, /\*\.localhost/)
  })
})
