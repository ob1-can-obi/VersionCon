import * as vscode from 'vscode';
import type { SystemEventSubKind } from '../types/chat.js';
import type { AffectedSymbol } from '../ast/types.js';

/**
 * Sub-classification kinds rendered in the activity log. Mirrors the SystemEventSubKind
 * union from the chat types plus a synthetic 'chat-unread' marker for the sticky row.
 *
 * @internal The compile-time check below ensures we cover every SystemEventSubKind so
 * that adding a new system event kind in src/types/chat.ts is caught at build time.
 */
export type ActivityKind =
  | 'push'
  | 'revert'
  | 'branch-created'
  | 'chat-unread'
  // Phase 6 Wave 1 (Plan 06-01): the activity log MUST cover every
  // SystemEventSubKind to satisfy the exhaustiveness assertion below. The
  // 5 review sub-kinds render via a generic "review event" placeholder until
  // Wave 4 (Plan 06-04) wires review-specific copy + icons + commands. The
  // tree presently never emits these — Plan 06-04 calls `addReviewEntry`
  // (planned) — but the type contract must be in place for Waves 2-5 to
  // compile against.
  | 'review-opened'
  | 'review-comment'
  | 'review-approved'
  | 'review-changes-requested'
  | 'review-resolved';

// Compile-time exhaustiveness: every SystemEventSubKind must be representable as an
// ActivityKind. If a new SystemEventSubKind is added without extending ActivityKind,
// this type assertion fails at build time.
type _AssertSystemSubKindsCovered = SystemEventSubKind extends ActivityKind ? true : never;
const _systemSubKindsCovered: _AssertSystemSubKindsCovered = true;
void _systemSubKindsCovered;

export interface ActivityEntry {
  kind: ActivityKind;
  /** Unique per entry; for the unread-chat row this is the literal 'unread-chat-sticky'. */
  id: string;
  /** Host-arrival ms epoch (Plan 04-04). For the sticky-unread row this is upsert time. */
  timestamp: number;
  /** Authenticated sender id; empty string for the sticky-unread row. */
  memberId: string;
  /** Display name resolved at relay time; empty string for the sticky-unread row. */
  memberDisplayName: string;
  /** True iff `memberId === selfId`. Resolved by the caller (extension.ts wiring). */
  isMine: boolean;
  // ----- Push / revert fields -----
  /** Workspace-relative paths touched by the underlying push/revert. */
  files?: string[];
  /** Push commit message. Rendered in the tooltip when present. */
  pushMessage?: string;
  /** True when the push touched a file the local user has open (Plan 04-06). */
  affectsLocal?: boolean;
  /**
   * Phase 5 Plan 05-05 (SC-5): the related chat record id. Stamped onto push
   * entries via `linkChatRecordToPush` when the corresponding chat-received
   * system-event arrives. Used by `applyAmend` to locate the entry when the
   * host broadcasts a chat-message-amend with AST-derived affectedSymbols.
   */
  chatRecordId?: string;
  /** Phase 5 Plan 05-05 (SC-5): the underlying push id (so chat record amends can be linked). */
  pushId?: string;
  /**
   * Phase 5 Plan 05-05 (SC-5): per-symbol impact populated by the host AST
   * analyzer's amend. Absent when analyzer is unwired, returns empty, or
   * the entry pre-dates Phase 5. Drives the upgraded `affects N of your
   * symbols` label in formatLabel.
   */
  affectedSymbols?: AffectedSymbol[];
  /**
   * Phase 5 Plan 05-05 (SC-3 fallback signal): list of language ids that fell
   * through to file-level fallback for this push. Drives the tooltip suffix
   * `Symbol analysis unavailable for: …`.
   */
  unsupportedLanguages?: string[];
  // ----- Branch-create field -----
  branchName?: string;
  // ----- Chat-unread sticky field -----
  unreadCount?: number;
}

const RING_BUFFER_CAP = 200;
const UNREAD_STICKY_ID = 'unread-chat-sticky';

/**
 * TreeDataProvider for the `versioncon.activityLog` view (sidebar).
 *
 * - Holds an in-memory ring buffer of last 200 non-sticky entries (UI-SPEC §1.2).
 * - Sticky unread-chat row at the top of the rendered list when unread > 0 (UI-SPEC §2.2).
 * - Reverse-chronological flat list (newest after the sticky row).
 * - No persistence — the activity tree is a derived projection of the chat-log
 *   broadcast stream (RESEARCH §"Activity tree storage"). Source of truth lives in
 *   `.versioncon/branches/<branch>/chat-log.json`.
 *
 * Plan 04-09 wires `addPushEntry` / `addRevertEntry` / `addBranchCreateEntry` calls
 * onto SessionClient events. Plan 04-10 wires `setUnread` from chat panel viewstate.
 */
export class ActivityLogProvider implements vscode.TreeDataProvider<ActivityEntry> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ActivityEntry | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private entries: ActivityEntry[] = [];

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  // ----- Public mutators -----

  addPushEntry(partial: Omit<ActivityEntry, 'kind' | 'id'> & { id?: string }): void {
    this.pushEntry({
      ...partial,
      kind: 'push',
      id: partial.id ?? this.makeId('push', partial.timestamp),
    });
  }

  addRevertEntry(partial: Omit<ActivityEntry, 'kind' | 'id'> & { id?: string }): void {
    this.pushEntry({
      ...partial,
      kind: 'revert',
      id: partial.id ?? this.makeId('revert', partial.timestamp),
    });
  }

  addBranchCreateEntry(partial: Omit<ActivityEntry, 'kind' | 'id'> & { id?: string }): void {
    this.pushEntry({
      ...partial,
      kind: 'branch-created',
      id: partial.id ?? this.makeId('branch', partial.timestamp),
    });
  }

  /**
   * Upsert (count > 0) or remove (count === 0) the single sticky unread-chat row.
   * Single-sticky invariant: setUnread always filters any prior sticky before insert,
   * so concurrent calls cannot leave the tree with two unread rows.
   */
  setUnread(count: number): void {
    // Remove any existing sticky.
    this.entries = this.entries.filter(e => e.id !== UNREAD_STICKY_ID);
    if (count > 0) {
      this.entries.push({
        kind: 'chat-unread',
        id: UNREAD_STICKY_ID,
        timestamp: Date.now(),
        memberId: '',
        memberDisplayName: '',
        isMine: false,
        unreadCount: count,
      });
    }
    this.refresh();
  }

  clear(): void {
    this.entries = [];
    this.refresh();
  }

  /** Returns a defensive copy of the in-memory entries (mirrors ChatLog/PresenceMap). */
  getEntries(): ActivityEntry[] {
    return [...this.entries];
  }

  /**
   * Phase 5 Plan 05-05 (SC-5): record the chat record id that corresponds to
   * a previously-added push activity entry. Called by extension.ts when the
   * `chat-received` system-event arrives carrying `meta.pushId === pushId`.
   * Used as the lookup key for `applyAmend` so we can find the right entry
   * when the host broadcasts a chat-message-amend (whose only correlation
   * back to the activity row is the chat record id).
   *
   * No-op when no push entry matches the pushId (e.g. amend race or
   * never-added entry from before the link landed).
   */
  linkChatRecordToPush(pushId: string, chatRecordId: string): void {
    // Match the most recent push entry with this pushId — earlier pushes with
    // the same id are theoretically impossible (pushIds are random), but the
    // reverse-find is more defensive against test setups that reuse ids.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.kind === 'push' && e.pushId === pushId && !e.chatRecordId) {
        this.entries[i] = { ...e, chatRecordId };
        return;
      }
    }
  }

  /**
   * Phase 5 Plan 05-05 (SC-5): patch a push entry's affectedSymbols +
   * unsupportedLanguages after AST analysis completes. Called by
   * extension.ts when client/host receives a chat-message-amend event.
   *
   * Lookup is by chatRecordId (set via linkChatRecordToPush above). No-op
   * when the entry isn't found — covers the T-05-06 accepted race
   * (amend before original) and the chat-cleared truncation case.
   */
  applyAmend(
    recordId: string,
    affectedSymbols: AffectedSymbol[],
    unsupportedLanguages: string[],
  ): void {
    const idx = this.entries.findIndex(e => e.chatRecordId === recordId);
    if (idx < 0) return;
    this.entries[idx] = {
      ...this.entries[idx],
      affectedSymbols,
      unsupportedLanguages,
    };
    this.refresh();
  }

  private pushEntry(entry: ActivityEntry): void {
    this.entries.push(entry);
    // Cap the non-sticky entries at RING_BUFFER_CAP. The sticky unread row is exempt
    // from the cap (UI-SPEC §1.2 hard cap is on activity entries; sticky is a marker).
    const sticky = this.entries.find(e => e.id === UNREAD_STICKY_ID);
    const nonSticky = this.entries.filter(e => e.id !== UNREAD_STICKY_ID);
    if (nonSticky.length > RING_BUFFER_CAP) {
      const trimmed = nonSticky.slice(-RING_BUFFER_CAP);
      this.entries = sticky ? [sticky, ...trimmed] : trimmed;
    }
    this.refresh();
  }

  private makeId(prefix: string, timestamp: number): string {
    return `${prefix}-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // ----- TreeDataProvider impl -----

  getTreeItem(element: ActivityEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(this.formatLabel(element), vscode.TreeItemCollapsibleState.None);
    item.description = this.formatDescription(element);
    item.tooltip = this.formatTooltip(element);
    item.iconPath = this.iconForEntry(element);
    item.command = this.commandForEntry(element);
    item.contextValue = `activity-${element.kind}`;
    return item;
  }

  async getChildren(element?: ActivityEntry): Promise<ActivityEntry[]> {
    if (element) return []; // flat tree
    // Sticky unread first, then reverse-chronological (newest first).
    const sticky = this.entries.find(e => e.id === UNREAD_STICKY_ID);
    const others = this.entries
      .filter(e => e.id !== UNREAD_STICKY_ID)
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp);
    return sticky ? [sticky, ...others] : others;
  }

  // ----- Formatting helpers (per UI-SPEC §6.3) -----

  private formatLabel(e: ActivityEntry): string {
    switch (e.kind) {
      case 'push': {
        const n = e.files?.length ?? 0;
        // Phase 5 Plan 05-05 (SC-5): when AST analysis identified caller
        // symbols, render the smart-summary label. Cap displayed symbols at
        // 3 + ', …' for the long-tail case (matches the webview render path
        // for consistency — every render path uses the same truncation rule).
        const sym = e.affectedSymbols ?? [];
        if (sym.length > 0) {
          const top3 = sym.slice(0, 3).map(s => `${s.name}()`).join(', ');
          const more = sym.length > 3 ? ', …' : '';
          const who = e.isMine ? 'You' : e.memberDisplayName;
          return `${who} pushed ${n} file(s) — affects ${sym.length} of your symbols: ${top3}${more}`;
        }
        // Fallback: pre-Phase-5 label paths. isMine / affectsLocal remain
        // the v1 distinction when affectedSymbols is empty (analyzer
        // unwired, empty result, or fallback-only with no symbols).
        if (e.isMine) return `You pushed ${n} file(s)`;
        if (e.affectsLocal) return `${e.memberDisplayName} pushed ${n} file(s) — affects you`;
        return `${e.memberDisplayName} pushed ${n} file(s)`;
      }
      case 'revert': {
        const n = e.files?.length ?? 0;
        return e.isMine
          ? `You reverted ${n} file(s)`
          : `${e.memberDisplayName} reverted ${n} file(s)`;
      }
      case 'branch-created': {
        const name = e.branchName ?? 'unknown';
        return e.isMine
          ? `You created branch '${name}'`
          : `${e.memberDisplayName} created branch '${name}'`;
      }
      case 'chat-unread':
        return `$(circle-filled) ${e.unreadCount ?? 0} unread message(s)`;
      // Phase 6 Wave 1 (Plan 06-01): placeholder labels — Wave 4 (Plan 06-04)
      // overrides with review-specific copy. No code path emits these entries
      // yet; the cases exist solely to satisfy the exhaustiveness check on
      // ActivityKind (which mirrors SystemEventSubKind).
      case 'review-opened':
        return e.isMine ? 'You opened a review' : `${e.memberDisplayName} opened a review`;
      case 'review-comment':
        return e.isMine ? 'You commented on a review' : `${e.memberDisplayName} commented on a review`;
      case 'review-approved':
        return e.isMine ? 'You approved a review' : `${e.memberDisplayName} approved a review`;
      case 'review-changes-requested':
        return e.isMine ? 'You requested changes on a review' : `${e.memberDisplayName} requested changes on a review`;
      case 'review-resolved':
        return e.isMine ? 'You resolved a review' : `${e.memberDisplayName} resolved a review`;
    }
  }

  private formatDescription(e: ActivityEntry): string {
    if (e.kind === 'chat-unread') return '';
    return formatRelativeTime(e.timestamp);
  }

  private formatTooltip(e: ActivityEntry): string | undefined {
    if (e.kind === 'chat-unread') return 'Click to open chat';
    const iso = new Date(e.timestamp).toISOString();
    if (e.kind === 'push' || e.kind === 'revert') {
      const msg = e.pushMessage ? `\n"${e.pushMessage}"` : '';
      // Phase 5 Plan 05-05 (SC-3): append the "Symbol analysis unavailable"
      // suffix when the analyzer flagged unsupported languages for this push.
      const unsupported = (e as ActivityEntry).unsupportedLanguages ?? [];
      const fallback = unsupported.length > 0
        ? `\nSymbol analysis unavailable for: ${unsupported.join(', ')}`
        : '';
      return `${iso}${msg}${fallback}`;
    }
    if (e.kind === 'branch-created') return iso;
    return undefined;
  }

  private iconForEntry(e: ActivityEntry): vscode.ThemeIcon {
    switch (e.kind) {
      case 'push':
        if (e.isMine) return new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('testing.iconPassed'));
        if (e.affectsLocal)
          return new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('editorWarning.foreground'));
        return new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('charts.blue'));
      case 'revert':
        return new vscode.ThemeIcon('discard', new vscode.ThemeColor('errorForeground'));
      case 'branch-created':
        return new vscode.ThemeIcon('git-branch', new vscode.ThemeColor('descriptionForeground'));
      case 'chat-unread':
        return new vscode.ThemeIcon('comment', new vscode.ThemeColor('charts.blue'));
      // Phase 6 Wave 1 (Plan 06-01): placeholder icons — Wave 4 (Plan 06-04)
      // overrides with review-specific icons. Exhaustiveness gate only.
      case 'review-opened':
      case 'review-comment':
      case 'review-changes-requested':
        return new vscode.ThemeIcon('comment-discussion', new vscode.ThemeColor('charts.blue'));
      case 'review-approved':
        return new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
      case 'review-resolved':
        return new vscode.ThemeIcon('verified', new vscode.ThemeColor('descriptionForeground'));
    }
  }

  private commandForEntry(e: ActivityEntry): vscode.Command | undefined {
    if (e.kind === 'chat-unread') {
      return { command: 'versioncon.openChat', title: 'Open Chat' };
    }
    // Plan 04-09 registers `versioncon.activityLog.openEntry` and dispatches the right
    // action per kind (push/revert → smart push summary modal; branch → switchBranch
    // picker). UI-SPEC §3.2 specifies the routing; this provider only declares the
    // command name + carries the entry as the single argument.
    return { command: 'versioncon.activityLog.openEntry', title: 'Open', arguments: [e] };
  }
}

/**
 * UI-SPEC §6.3 relative time formatter. Pure function so tests can pin `now`.
 *
 * - `< 10s` → `"just now"`
 * - `< 60s` → `"{N}s ago"`
 * - `< 60m` → `"{N}m ago"`
 * - `< 24h` → `"{N}h ago"`
 * - `≥ 24h` → `"{N}d ago"`
 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
