/**
 * Kitchen Sink — the overlay's proof-of-install target.
 *
 * TWO PATHS LIVE IN THIS FILE, and which one runs is decided by `localStorage`.
 *
 * 1. **The product path (default).** `defineOverlayConfig` from
 *    `sanity-overlay-studio` installs the interception, the hosted-feature
 *    switches, the document-action filter and the status banner. This is the
 *    single line a real consumer writes, and it is what a browser check should
 *    exercise.
 *
 * 2. **The Spike A path.** If ANY `SPIKE_*` flag is present in `localStorage`,
 *    the config falls back to `spikeClientFactory` exactly as before — same
 *    factory, same flags, same topologies (Track A / D13 hybrid / local echo).
 *    Every Phase-1 evidence procedure in
 *    `docs/plans/evidence/phase-1/spike-a-studio-interception/` is written as
 *    "set these localStorage flags, reload", so those procedures keep working
 *    byte-for-byte: setting a flag is *itself* the switch back.
 *
 *    (The spike *tests* never load this file — they import
 *    `spikeA/instrumentedClient` directly — so they are unaffected either way.)
 *
 * The package is imported by relative path, as everything else in this repo is.
 * A real consumer writes `pnpm add sanity-overlay-studio` and
 * `import {defineOverlayConfig} from 'sanity-overlay-studio'`, which also wires
 * `createClient` and React for them; here they are passed explicitly so the
 * example needs no install of its own.
 */
import './spikeA/eventSourceTap'
import {createElement, useEffect, useState} from 'react'
import {createClient} from '@sanity/client'
import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {schemaTypes} from './schemaTypes'
import {spikeClientFactory} from './spikeA/instrumentedClient'
import {defineOverlayConfig} from '../../packages/sanity-overlay-studio/src/config'
import {createOverlayStatusLayout} from '../../packages/sanity-overlay-studio/src/ui/statusLayout'

/** The flags every Spike A evidence run sets. Any one of them selects the spike. */
const SPIKE_FLAGS = [
  'SPIKE_LOCAL_ECHO',
  'SPIKE_API_HOST',
  'SPIKE_INSTRUMENT',
  'SPIKE_OVERLAY_PERSIST',
  'SPIKE_STRICT_QUERIES',
]

function spikePathRequested(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    return SPIKE_FLAGS.some((flag) => (localStorage.getItem(flag) ?? '').trim() !== '')
  } catch {
    return false
  }
}

const workspace = {
  name: 'kitchen-sink',
  title: 'Kitchen Sink (overlay test target)',
  projectId: process.env.SANITY_STUDIO_PROJECT_ID || 'b1n03q3z',
  dataset: process.env.SANITY_STUDIO_DATASET || 'parity',
  plugins: [structureTool()],
  schema: {types: schemaTypes},
}

export default spikePathRequested()
  ? // SPIKE A path — unchanged from the original lab rig (§36.1).
    defineConfig({...workspace, unstable_clientFactory: spikeClientFactory})
  : // Product path — the one line `sanity-overlay-studio` exists to make possible.
    defineOverlayConfig(workspace, {
      env: process.env as Record<string, string | undefined>,
      createClient: (options) => createClient(options as never) as unknown as object,
      layout: createOverlayStatusLayout({createElement, useEffect, useState}),
    })
