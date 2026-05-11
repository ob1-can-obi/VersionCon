import * as vscode from 'vscode';
import type { DiffResult } from '../services/WorkspaceDiffer.js';

/**
 * Phase 4.3 SC-5: status-bar item that surfaces uncommitted workspace
 * changes relative to the active branch dir.
 *
 * Distinct from {@link import('./StatusBarManager.js').StatusBarManager}
 * (connection state + unread chat overlay) — this is a SECOND, right-
 * aligned, lower-priority item that only appears when N>0 changes are
 * present. The two items coexist; the existing StatusBarManager is
 * intentionally NOT modified by Wave 3.
 *
 * Lifecycle (driven by extension.ts wiring, not this class):
 *   1. constructor()           — creates a hidden StatusBarItem.
 *   2. refresh(diff)           — called by the debounced FileSystemWatcher
 *                                 in extension.ts after every workspace
 *                                 change. Shows the item with
 *                                 `$(git-pull-request) N local change(s)`
 *                                 when N>0; hides it when N=0.
 *   3. hide()                  — caller-driven manual hide (e.g. when the
 *                                 session disconnects and "local changes vs.
 *                                 branch" stops making sense).
 *   4. dispose()               — releases the underlying StatusBarItem.
 *
 * Click behavior: the item's command is `versioncon.diff` (registered by
 * extension.ts in Wave 3 Task 3). Clicking opens a QuickPick over the
 * changed files; selecting one opens vscode.diff between branch ↔ workspace.
 *
 * This class is intentionally diff-data-driven, not differ-aware: it takes
 * a `DiffResult` as an argument so callers (and tests) keep full control
 * over when and how the diff runs. No internal polling, no FileSystemWatcher
 * subscription — those concerns live in extension.ts.
 */
export class LocalChangesStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    // Right alignment, priority 99 — to the RIGHT of the existing
    // StatusBarManager (Left, priority 100). The two items appear on
    // opposite sides of the status bar.
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99,
    );
    // Click command set ONCE at construction. The command itself is
    // registered by extension.ts (Wave 3 Task 3) — a QuickPick + vscode.diff
    // pipeline that consumes the same diff data this bar renders.
    this.item.command = 'versioncon.diff';
    // Item starts hidden — refresh() is the only path that calls .show().
  }

  /**
   * Re-render the status-bar item from a fresh {@link DiffResult}.
   *
   * - N>0 → text `$(git-pull-request) N local change(s)`; tooltip lists
   *   the first 5 changed paths with a "…and X more" suffix when N>5;
   *   item shown.
   * - N=0 → item hidden; text left as-is so a future refresh that flips
   *   back to N>0 can rebuild it cleanly.
   *
   * The class only inspects `allChanged.length` today; the singular/plural
   * suffix is a string-level concern, not a diff-shape concern.
   */
  refresh(diff: Pick<DiffResult, 'allChanged'>): void {
    const n = diff.allChanged.length;
    if (n === 0) {
      this.item.hide();
      return;
    }
    // Singular "local change" for N=1, "local change(s)" otherwise. The
    // (s) is intentional ASCII so the source-grep test can pin the exact
    // text without dealing with unicode quirks.
    const label = n === 1 ? 'local change' : 'local change(s)';
    this.item.text = `$(git-pull-request) ${n} ${label}`;
    // Tooltip preview — first 5 paths so the user can verify what's
    // changed before clicking through to the QuickPick. The "…and X more"
    // suffix prevents the tooltip from growing unbounded.
    const preview = diff.allChanged.slice(0, 5).join('\n');
    const moreCount = n > 5 ? n - 5 : 0;
    const moreSuffix = moreCount > 0 ? `\n…and ${moreCount} more` : '';
    this.item.tooltip = `Click to preview before pushing\n${preview}${moreSuffix}`;
    this.item.show();
  }

  /**
   * Manual hide — for callers (extension.ts) that want to suppress the
   * indicator when there is no active VersionCon session and the "local
   * changes vs. branch" concept no longer applies. Idempotent.
   */
  hide(): void {
    this.item.hide();
  }

  // ----- Test helpers (mirror StatusBarManager.getItemTextForTest pattern) -----

  /** Test-only: read raw item text for assertion. */
  getItemTextForTest(): string {
    return this.item.text;
  }

  /** Test-only: read raw item command id for assertion. */
  getItemCommandForTest(): string | vscode.Command | undefined {
    return this.item.command;
  }

  /** Test-only: read raw tooltip for assertion. */
  getItemTooltipForTest(): string | vscode.MarkdownString | undefined {
    return this.item.tooltip;
  }

  dispose(): void {
    this.item.dispose();
  }
}
