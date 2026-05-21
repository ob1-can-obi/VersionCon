// src/mcp/adapters/ActivityReaderImpl.ts
// Phase 8 — Reader adapter wrapping PushHistory (read-only pass-through).
//
// PushHistory.getRecords() returns the records in NEWEST-FIRST order
// (PushHistory.ts:42-44 — `return [...this.records].reverse();`). The adapter
// preserves that ordering and slices to the caller's requested limit.
//
// Negative `limit` is normalized to 0 (no throw) — defensive against
// arithmetic the AI agent might produce.
import type { ActivityReader } from '../readers.js';
import type { PushHistory } from '../../filesystem/PushHistory.js';
import type { PushRecord } from '../../types/push.js';

/**
 * Layer-2 (runtime) implementation of {@link ActivityReader} backed by the
 * existing PushHistory. Slices `getRecords()` (already newest-first) to the
 * requested limit. PushHistory itself returns a fresh array per call so
 * the adapter does NOT need its own defensive copy.
 */
export class ActivityReaderImpl implements ActivityReader {
  constructor(private readonly history: PushHistory) {}

  /**
   * Returns the most recent N push records (newest-first per the PushHistory
   * contract — see PushHistory.ts:42 JSDoc). Negative `limit` is treated
   * as 0; fractional `limit` is floored.
   */
  getRecentPushes(limit: number): readonly PushRecord[] {
    const n = Math.max(0, Math.floor(limit));
    if (n === 0) return [];
    return this.history.getRecords().slice(0, n);
  }
}
