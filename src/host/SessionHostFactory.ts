// -----------------------------------------------------------------------------
// SessionHostFactory — STUB pending Task 3 GREEN-part-2.
//
// This file is intentionally a thin stub during the GREEN-part-1 commit so
// that mocha's loadFiles() can resolve the import in
// src/test/suite/hostCloudWiring.test.ts without crashing the test runner
// before the cloudHostDemux suite has a chance to load. Task 3 replaces this
// stub with the full implementation (per the 07-05b plan).
// -----------------------------------------------------------------------------

import type { SessionHost } from './SessionHost.js';
import type { HostIdentity, SessionConfig } from '../types/session.js';
import type { ClientTransport } from '../network/Transport.js';

export interface CreateCloudOpts {
  config: SessionConfig;
  hostIdentity: HostIdentity;
  relayUrl: string;
  sessionId: string;
  /** Test-only seam — injects a fake ClientTransport instead of a real CloudTransport. */
  _testClientTransport?: ClientTransport;
}

export async function createCloud(_opts: CreateCloudOpts): Promise<SessionHost> {
  throw new Error(
    'SessionHostFactory.createCloud is not yet implemented (Task 3 of 07-05b).',
  );
}
