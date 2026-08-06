/**
 * Suite-wide setup. Runs before EVERY test file in this package.
 *
 * Its only job is to install the outbound-request monitor, which refuses any
 * non-GET request addressed to a Sanity host from anywhere in the suite. See
 * `src/outboundMonitor.ts` for why this is enforcement rather than observation,
 * and `test/no-staging-writes.test.ts` for its self-tests.
 */
import {installOutboundRequestMonitor} from './src/outboundMonitor'

installOutboundRequestMonitor()
