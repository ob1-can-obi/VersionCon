// src/mcp/adapters/PresenceReaderImpl.ts
// Phase 8 — Reader adapter wrapping SessionHost presence + member-tracking.
//
// T-08-02 (Information Disclosure of internal mutable state) mitigation:
// every return value is DEFENSIVE-COPIED so callers cannot mutate the
// SessionHost's internal state by mutating an adapter return value.
//
// Defense-in-depth:
//   - SessionHost.getPresenceSnapshot already returns a defensive copy
//     (PresenceMap.getSnapshot at SessionHost.ts:2002-2004). We copy AGAIN
//     so the adapter seam is explicit + survives any future SessionHost
//     contract change that drops its own copy.
//   - SessionHost.getMemberTracking returns `new Map(this.memberTracking)`
//     — but the Map VALUES (string arrays) are LIVE references to the
//     internal state's arrays. The adapter clones each value array.
//
// PresenceInfo lives in src/types/chat.ts (NOT src/types/session.ts) per
// 08-01-SUMMARY finding. The `activeFilePath: string | null` field is the
// active-file marker.
import type { PresenceReader } from '../readers.js';
import type { SessionHost } from '../../host/SessionHost.js';
import type { PresenceInfo } from '../../types/chat.js';

/**
 * Layer-2 (runtime) implementation of {@link PresenceReader} backed by the
 * existing SessionHost. Defensive-copies every return value so the wrapped
 * host's internal state cannot be mutated through the Reader surface.
 */
export class PresenceReaderImpl implements PresenceReader {
  constructor(private readonly host: SessionHost) {}

  getPresenceSnapshot(): readonly PresenceInfo[] {
    return [...this.host.getPresenceSnapshot()];
  }

  getMemberTracking(): ReadonlyMap<string, readonly string[]> {
    const live = this.host.getMemberTracking();
    const copy = new Map<string, readonly string[]>();
    for (const [memberId, paths] of live.entries()) {
      copy.set(memberId, [...paths]);
    }
    return copy;
  }
}
