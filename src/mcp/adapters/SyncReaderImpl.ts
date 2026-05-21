// src/mcp/adapters/SyncReaderImpl.ts
// Phase 8 — Reader adapter wrapping SyncTracker (read-only pass-through).
//
// SyncTracker.getOutOfSyncPaths() already returns a fresh array (Array.from
// over an internal Set — SyncTracker.ts:92-94), so the adapter is a pure
// pass-through. SyncTracker.getLatestPushId() returns a primitive (string |
// null) — no copy needed.
import type { SyncReader } from '../readers.js';
import type { SyncTracker } from '../../filesystem/SyncTracker.js';

/**
 * Layer-2 (runtime) implementation of {@link SyncReader} backed by the
 * existing SyncTracker. SyncTracker is in-memory and resets per host process
 * — this Reader surface intentionally mirrors that volatility.
 */
export class SyncReaderImpl implements SyncReader {
  constructor(private readonly tracker: SyncTracker) {}

  getOutOfSyncPaths(): readonly string[] {
    return this.tracker.getOutOfSyncPaths();
  }

  getLatestPushId(): string | null {
    return this.tracker.getLatestPushId();
  }
}
