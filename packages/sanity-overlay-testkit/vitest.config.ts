import {defineConfig} from 'vitest/config'

/**
 * The suite previously ran on vitest's defaults with no config file at all. This
 * config exists for ONE reason: `setupFiles`, which installs the suite-wide
 * outbound-request monitor into every test file (`vitest.setup.ts`).
 *
 * Everything else is left at its default deliberately, so the file set and the
 * runner behaviour are unchanged from the pre-config baseline (88 files before
 * the promotion planner was deleted; 84 after).
 */
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
  },
})
