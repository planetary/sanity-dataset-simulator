import assert from 'node:assert/strict'
import {execFile, spawn} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {after, before, describe, it} from 'node:test'
import {PLACEHOLDER_TOKEN} from '../src/cli.js'

const BIN = fileURLToPath(new URL('../bin/sanity-sim.js', import.meta.url))
const cli = async (root, ...args) => (await promisify(execFile)(process.execPath, [BIN, ...args, '--root', root, '--yes'], {cwd: root, env: {...process.env, SANITY_SIM_HOME: root}})).stdout
const freshRoot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sanity-sim-cli-')))
const config = (root) => JSON.parse(fs.readFileSync(path.join(root, '.sanity-sim', 'config.json'), 'utf8'))

describe('cli', () => {
  let root
  before(() => {
    root = freshRoot()
    fs.writeFileSync(path.join(root, 'a.ndjson'), '{"_id":"a","_type":"post","title":"A"}\n')
  })

  it('keeps the folder default when the first command names another dataset', async () => {
    await cli(root, 'import', 'a.ndjson', '--dataset', 'test-2')
    assert.equal(config(root).defaultDataset, 'production')
    assert.match(await cli(root, 'import', 'a.ndjson'), /into production/)
  })

  it('links offline, and status shows it', async () => {
    assert.match(await cli(root, 'link', 'production', 'test-2'), /production → test-2 \(its previous documents are kept as "production-original"\)/)
    assert.match(await cli(root, 'status'), /link production → test-2/)
  })

  it('refuses a bad link with a clear message', async () => {
    await assert.rejects(cli(root, 'link', 'production', 'production'), /cannot link to itself/)
  })

  describe('the read token dev scripts get (Draft Mode needs one)', () => {
    /* Start the simulator with a dev script that records SANITY_API_READ_TOKEN, then stop it. */
    const tokenSeen = async (envFile) => {
      const dir = freshRoot()
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'app', private: true, scripts: {dev: `node -e "require('fs').writeFileSync('token.txt', process.env.SANITY_API_READ_TOKEN ?? 'none')"`}}))
      if (envFile) fs.writeFileSync(path.join(dir, '.env'), envFile)
      const {SANITY_API_READ_TOKEN: _ignored, ...env} = process.env
      const child = spawn(process.execPath, [BIN, '--root', dir, '--port', String(39500 + Math.floor(Math.random() * 400)), '--http', '--yes'], {cwd: dir, env: {...env, SANITY_SIM_HOME: dir}, stdio: 'pipe'})
      try {
        const file = path.join(dir, 'token.txt')
        for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise((resolve) => setTimeout(resolve, 100))
        return fs.readFileSync(file, 'utf8')
      } finally {
        child.kill()
      }
    }

    it('is a placeholder when the project has no token', async () => {
      assert.equal(await tokenSeen(), PLACEHOLDER_TOKEN)
    })

    it('is left alone when the project has its own', async () => {
      assert.equal(await tokenSeen('SANITY_API_READ_TOKEN=real-token\n'), 'none')
    })
  })

  describe('with a simulator running for the folder', () => {
    let server
    let port
    before(async () => {
      port = 39000 + Math.floor(Math.random() * 500)
      server = spawn(process.execPath, [BIN, 'serve', '--root', root, '--port', String(port), '--http', '--yes'], {env: {...process.env, SANITY_SIM_HOME: root}, stdio: 'pipe'})
      for (let i = 0; i < 50; i++) {
        try {
          await fetch(`http://127.0.0.1:${port}/_sim/status`)
          return
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
    })
    after(() => server.kill())

    it('hot-swaps through the running server, found on whatever port it took, instead of editing files under it', async () => {
      assert.match(await cli(root, 'link', 'production', 'production-original'), /connected clients are reloading/)
      const links = await (await fetch(`http://127.0.0.1:${port}/_sim/links`)).json()
      assert.deepEqual(links, [{name: 'production', target: 'production-original'}])
    })
  })
})
