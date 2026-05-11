import * as fs from 'fs/promises';
import * as path from 'path';
import type { ChatRecord } from '../types/chat.js';

/**
 * Append-only chat log persisted to .versioncon/branches/<branch>/chat-log.json
 * on the host's filesystem. Mirrors PushHistory.ts pattern.
 *
 * Concurrency: single host process serializes appends via await. No .tmp+rename
 * (matches PushHistory; both upgrade together if atomicity becomes a need).
 *
 * Order: getRecords() returns chronological (oldest first) — DIFFERENT from
 * PushHistory which returns newest first. Chat displays oldest-at-top.
 *
 * Threat mitigations (per Plan 04-02 STRIDE register):
 * - T-04-02-02 (DoS via unbounded growth): three truncation modes provide a
 *   manual escape valve. Auto-truncation deferred to backlog 999.x.
 * - T-04-02-04 (concurrent host writes): v1 has exactly one host process;
 *   atomic-rename upgrade deferred jointly with PushHistory.
 */
export class ChatLog {
  private readonly chatLogFile: string;
  private records: ChatRecord[] = [];

  constructor(branchDir: string) {
    this.chatLogFile = path.join(branchDir, 'chat-log.json');
  }

  /**
   * Load chat records from disk. Call once at startup. Missing file is treated
   * as empty (matches PushHistory.load — first-launch semantics).
   */
  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.chatLogFile, 'utf-8');
      this.records = JSON.parse(data);
    } catch {
      this.records = [];
    }
  }

  /**
   * Persist current records to disk. Whole-file rewrite — same as PushHistory.
   * Single host event-loop serialization makes this safe under concurrent appends.
   */
  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.chatLogFile), { recursive: true });
    await fs.writeFile(this.chatLogFile, JSON.stringify(this.records, null, 2));
  }

  /**
   * Append a chat record (user message or system event) and persist.
   * Mirrors PushHistory.addRecord. Caller is responsible for assigning the
   * host-arrival timestamp before calling — this method does not stamp time.
   */
  async append(record: ChatRecord): Promise<void> {
    this.records.push(record);
    await this.save();
  }

  /**
   * Phase 5 Plan 05-05 (SC-5): merge `patch` into an existing record's meta
   * and persist. Used by SessionHost.runAstAnalysisAndAmend to stamp
   * `affectedSymbols` + `unsupportedLanguages` onto the original push system
   * event AFTER the async AST analysis completes — so chat-history replay
   * (Plan 04-04) carries the amended meta to joiners who arrive after the
   * amend lands.
   *
   * Best-effort semantics:
   *   - No-op when the record id is missing (e.g. record evicted by a
   *     concurrent truncation; the live amend wire broadcast still fires and
   *     reaches currently-connected clients).
   *   - Whole-file rewrite via save() — same atomicity posture as append().
   *     Concurrent appends + patchMeta calls are safe in v1 because the
   *     single host process serializes both through the event loop; a future
   *     .tmp+rename upgrade is tracked in the Phase 4 STRIDE register as
   *     T-04-02-04.
   */
  async patchMeta(
    recordId: string,
    patch: Partial<NonNullable<ChatRecord['meta']>>,
  ): Promise<void> {
    const idx = this.records.findIndex(r => r.id === recordId);
    if (idx < 0) return;
    const existing = this.records[idx].meta ?? {};
    this.records[idx] = {
      ...this.records[idx],
      meta: { ...existing, ...patch },
    };
    await this.save();
  }

  /**
   * Returns all records in chronological order (oldest first).
   * NOTE: differs from PushHistory.getRecords() which returns newest first.
   * Chat displays oldest-at-top, scrolling down to newest.
   */
  getRecords(): ChatRecord[] {
    return [...this.records];
  }

  /**
   * Returns the most recent N records in chronological order.
   * Used for the join replay window (CONTEXT decision: replay = 100).
   */
  getRecent(n: number): ChatRecord[] {
    return this.records.slice(-n);
  }

  /**
   * Truncate the entire chat log to empty. Host-only destructive action
   * (Manage Chat → Delete entire chat). Persisted immediately.
   */
  async clearAll(): Promise<void> {
    this.records = [];
    await this.save();
  }

  /**
   * Keep all system events PLUS the most recent 100 user messages. Result is
   * re-sorted into chronological order with a deterministic tiebreaker on id.
   *
   * Rationale: createTimestamp() resolves to milliseconds; same-ms appends
   * can produce equal timestamps. Without the id tiebreaker, V8's sort is
   * unstable for those — output would vary across runs. Tiebreaker on
   * id.localeCompare guarantees deterministic order across reloads.
   */
  async truncateKeepLast100PlusActivity(): Promise<void> {
    const systemRecords = this.records.filter(r => r.kind === 'system');
    const userRecords = this.records.filter(r => r.kind === 'user');
    const recentUsers = userRecords.slice(-100);
    this.records = [...systemRecords, ...recentUsers].sort(
      (a, b) => (a.timestamp - b.timestamp) || a.id.localeCompare(b.id),
    );
    await this.save();
  }

  /**
   * Remove all user-authored messages, keeping every system event.
   * Chronological order preserved (filter is stable).
   */
  async truncateActivityOnly(): Promise<void> {
    this.records = this.records.filter(r => r.kind === 'system');
    await this.save();
  }

  /**
   * Export the chat log to a user-chosen file path in either JSON or markdown.
   * Per-user "Clear my view" is honored via `hiddenBefore` — records older than
   * that timestamp are excluded from the export so a user's local clear-view
   * does not leak hidden context into the exported file.
   */
  async exportToFile(
    targetPath: string,
    format: 'json' | 'md',
    hiddenBefore?: number,
  ): Promise<void> {
    const visible = hiddenBefore != null
      ? this.records.filter(r => r.timestamp >= hiddenBefore)
      : this.records;
    let content: string;
    if (format === 'json') {
      content = JSON.stringify(visible, null, 2);
    } else {
      // Markdown: one record per block. System events as block-quotes,
      // user messages as headed sections. Separator between records is
      // a horizontal rule.
      content = visible.map(r => {
        const tsIso = new Date(r.timestamp).toISOString();
        if (r.kind === 'system') {
          return `> _${r.memberDisplayName} · ${tsIso}_\n> ${r.body}`;
        }
        return `### ${r.memberDisplayName} · ${tsIso}\n\n${r.body}`;
      }).join('\n\n---\n\n');
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content);
  }
}
