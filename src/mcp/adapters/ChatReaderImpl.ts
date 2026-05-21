// src/mcp/adapters/ChatReaderImpl.ts
// Phase 8 — Reader adapter wrapping ChatLog (read-only pass-through).
//
// ChatLog.getRecent(n) returns the last N records in CHRONOLOGICAL order
// (newest-LAST — see ChatLog.ts:106-108) — opposite to PushHistory which is
// newest-first. The adapter preserves that ordering verbatim.
//
// Important edge case: ChatLog.getRecent uses `this.records.slice(-n)`,
// which returns the WHOLE array when n === 0 (since slice(-0) === slice(0)).
// We guard against that by short-circuiting to `[]` when n <= 0.
import type { ChatReader } from '../readers.js';
import type { ChatLog } from '../../filesystem/ChatLog.js';
import type { ChatRecord } from '../../types/chat.js';

/**
 * Layer-2 (runtime) implementation of {@link ChatReader} backed by the
 * existing ChatLog. Returns the most-recent N records oldest-first
 * (newest-last per ChatLog's contract).
 */
export class ChatReaderImpl implements ChatReader {
  constructor(private readonly chatLog: ChatLog) {}

  getRecent(limit: number): readonly ChatRecord[] {
    const n = Math.max(0, Math.floor(limit));
    if (n === 0) return [];
    return this.chatLog.getRecent(n);
  }
}
