import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';
import { LocalChangesStatusBar } from '../../ui/LocalChangesStatusBar.js';
import type { DiffResult } from '../../services/WorkspaceDiffer.js';

/**
 * Phase 4.3 Wave 3 — LocalChangesStatusBar (SC-5)
 *
 * Behavior tests for the new status-bar indicator class that mirrors the
 * existing StatusBarManager test pattern (statusBarManager.test.ts) — uses
 * the getItemTextForTest / getItemCommandForTest helpers to inspect the
 * underlying VS Code StatusBarItem without spinning up a webview.
 *
 * Mirrors UI-SPEC's principle of separating connection-state UI (owned by
 * StatusBarManager) from workspace-state UI (owned by LocalChangesStatusBar):
 * the existing manager is NOT touched by Wave 3.
 */
suite('Phase 4.3 Wave 3 — LocalChangesStatusBar (SC-5)', () => {
  let bar: LocalChangesStatusBar;

  setup(() => {
    bar = new LocalChangesStatusBar();
  });

  teardown(() => {
    bar.dispose();
  });

  // Helper to build a DiffResult with only allChanged populated; the bar
  // does not look at added/modified/deleted today, only allChanged.length.
  const makeDiff = (allChanged: string[]): DiffResult => ({
    added: [],
    modified: [],
    deleted: [],
    allChanged,
  });

  test('constructor creates a hidden StatusBarItem with click command versioncon.diff', () => {
    // Construction should not throw, and the click command must point at
    // versioncon.diff so the click handler can wire into Task 3's QuickPick.
    const cmd = bar.getItemCommandForTest();
    assert.strictEqual(cmd, 'versioncon.diff');
  });

  test('refresh with N=2 sets text to `$(git-pull-request) 2 local change(s)` and shows', () => {
    bar.refresh(makeDiff(['a.ts', 'b.ts']));
    const text = bar.getItemTextForTest();
    assert.match(
      text,
      /\$\(git-pull-request\) 2 local change\(s\)/,
      'expected `$(git-pull-request) 2 local change(s)` for N>1',
    );
  });

  test('refresh with N=1 uses singular `local change`', () => {
    bar.refresh(makeDiff(['a.ts']));
    const text = bar.getItemTextForTest();
    assert.match(text, /\$\(git-pull-request\) 1 local change(?!\()/, 'expected singular "local change" without (s)');
  });

  test('refresh with N=0 hides the item (text untouched is acceptable; we assert nothing about text)', () => {
    // First populate, then clear → exercises the hide branch.
    bar.refresh(makeDiff(['a.ts', 'b.ts', 'c.ts']));
    bar.refresh(makeDiff([]));
    // We can't directly assert .hide() vs .show() state via the public API
    // (VS Code does not expose item.visible). The contract is: hide() called
    // and text NOT updated to a stale N. So we assert the text was NOT changed
    // to "0 local change(s)".
    const text = bar.getItemTextForTest();
    assert.doesNotMatch(text, /0 local change/, 'must not render "0 local change(s)" when empty');
  });

  test('refresh updates tooltip with first 5 changed paths and a "more" suffix when N>5', () => {
    const many = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];
    bar.refresh(makeDiff(many));
    const tooltip = bar.getItemTooltipForTest();
    const tt = typeof tooltip === 'string' ? tooltip : tooltip?.value ?? '';
    assert.match(tt, /a\.ts/);
    assert.match(tt, /e\.ts/);
    assert.match(tt, /…and 2 more/, 'expected "…and 2 more" when N=7');
    // f.ts/g.ts must NOT appear in the preview slice
    assert.doesNotMatch(tt, /f\.ts/);
  });

  test('hide() can be called without prior refresh and does not throw', () => {
    // hide() must be idempotent and safe even when the item was never shown.
    assert.doesNotThrow(() => bar.hide());
  });

  test('dispose() disposes the underlying StatusBarItem; calling dispose twice does not throw', () => {
    // Standard VS Code disposable contract — dispose can be called repeatedly.
    assert.doesNotThrow(() => bar.dispose());
    assert.doesNotThrow(() => bar.dispose());
    // Re-create so teardown's dispose call doesn't double-tap a freed item.
    bar = new LocalChangesStatusBar();
  });
});

// -----------------------------------------------------------------------------
//
// Source-grep suite — Wave 3 wiring inside src/extension.ts. Each test reads
// the source once at module init (mirroring the workspaceDiff.test.ts Wave 2
// pattern at lines 247-250) and asserts the structural shape required for
// SC-5: workspace-wide FileSystemWatcher with a 500ms debounce that calls
// WorkspaceDiffer.diff and refreshes the LocalChangesStatusBar.
//
// -----------------------------------------------------------------------------

const EXTENSION_TS_PATH = path.resolve(process.cwd(), 'src/extension.ts');
const EXTENSION_SOURCE = fsSync.readFileSync(EXTENSION_TS_PATH, 'utf-8');

suite('Phase 4.3 Wave 3 — extension wiring (SC-5)', () => {
  test('extension.ts imports LocalChangesStatusBar from ./ui/', () => {
    assert.match(
      EXTENSION_SOURCE,
      /import\s*\{\s*LocalChangesStatusBar\s*\}\s*from\s*['"]\.\/ui\/LocalChangesStatusBar\.js['"]/,
      'expected `import { LocalChangesStatusBar } from "./ui/LocalChangesStatusBar.js"`',
    );
  });

  test('localChangesStatusBar singleton constructed in activate() and pushed to subscriptions', () => {
    assert.match(
      EXTENSION_SOURCE,
      /localChangesStatusBar\s*=\s*new\s+LocalChangesStatusBar\(\)/,
      'expected `localChangesStatusBar = new LocalChangesStatusBar()` at activate scope',
    );
    assert.match(
      EXTENSION_SOURCE,
      /context\.subscriptions\.push\(\s*localChangesStatusBar\s*\)/,
      'expected `context.subscriptions.push(localChangesStatusBar)` so VS Code disposes it on deactivate',
    );
  });

  test('workspace-wide FileSystemWatcher uses RelativePattern "**/*"', () => {
    assert.match(
      EXTENSION_SOURCE,
      /createFileSystemWatcher\([\s\S]{0,200}?RelativePattern\(\s*workspaceFolder\s*,\s*['"]\*\*\/\*['"]/,
      'expected createFileSystemWatcher(new RelativePattern(workspaceFolder, "**/*")) for the SC-5 watcher',
    );
  });

  test('debounce timer is 500ms (matches SPEC SC-5)', () => {
    // SC-5 mandates "within 500ms of a workspace file save". Pinning the
    // literal 500 inside a setTimeout that wraps a WorkspaceDiffer call.
    // Byte-cap is generous (1500 between WorkspaceDiffer and the `, 500)`
    // tail) because the async-IIFE body is multi-line with try/catch.
    assert.match(
      EXTENSION_SOURCE,
      /setTimeout\([\s\S]{0,2000}?WorkspaceDiffer[\s\S]{0,1500}?,\s*500\s*\)/,
      'expected setTimeout with 500ms literal wrapping a WorkspaceDiffer call (SC-5)',
    );
    // Defense-in-depth: also pin the specific localChangesDebounce assignment
    // so a refactor that drops the debounce identifier still trips the test.
    assert.match(
      EXTENSION_SOURCE,
      /localChangesDebounce\s*=\s*setTimeout\(/,
      'expected localChangesDebounce = setTimeout(...) assignment',
    );
  });

  test('recomputeLocalChanges wired to all three watcher events (onDidCreate / onDidChange / onDidDelete)', () => {
    assert.match(
      EXTENSION_SOURCE,
      /wsWatcher\.onDidCreate\(\s*recomputeLocalChanges\s*\)/,
      'expected wsWatcher.onDidCreate(recomputeLocalChanges)',
    );
    assert.match(
      EXTENSION_SOURCE,
      /wsWatcher\.onDidChange\(\s*recomputeLocalChanges\s*\)/,
      'expected wsWatcher.onDidChange(recomputeLocalChanges)',
    );
    assert.match(
      EXTENSION_SOURCE,
      /wsWatcher\.onDidDelete\(\s*recomputeLocalChanges\s*\)/,
      'expected wsWatcher.onDidDelete(recomputeLocalChanges)',
    );
  });

  test('session gate: indicator hidden when no active host or client (Rule 2 — beyond-plan UX guard)', () => {
    // The recomputeLocalChanges body must short-circuit to hide() when both
    // activeHost and activeClient are null. Pins the UX intent that the
    // indicator only surfaces when there is a session to push to.
    assert.match(
      EXTENSION_SOURCE,
      /if\s*\(\s*activeHost\s*===\s*null\s*&&\s*activeClient\s*===\s*null\s*\)\s*\{\s*localChangesStatusBar\?\.hide\(\)\s*;\s*return\s*;\s*\}/,
      'expected `if (activeHost === null && activeClient === null) { localChangesStatusBar?.hide(); return; }` session gate inside recomputeLocalChanges',
    );
  });

  test('initial refresh runs after the three onDid* registrations', () => {
    // The IIFE must call recomputeLocalChanges() ONCE at the bottom so the
    // status bar is correct at activation time without waiting for a save.
    const lastCreateIdx = EXTENSION_SOURCE.lastIndexOf('wsWatcher.onDidCreate(recomputeLocalChanges)');
    const lastDeleteIdx = EXTENSION_SOURCE.lastIndexOf('wsWatcher.onDidDelete(recomputeLocalChanges)');
    assert.ok(lastCreateIdx >= 0 && lastDeleteIdx >= 0, 'watcher event wiring not found');
    const tail = EXTENSION_SOURCE.slice(Math.max(lastCreateIdx, lastDeleteIdx));
    assert.match(
      tail,
      /recomputeLocalChanges\(\)\s*;/,
      'expected bare `recomputeLocalChanges();` call AFTER all three onDid* registrations (initial refresh)',
    );
  });
});

// -----------------------------------------------------------------------------
//
// versioncon.diff command source-grep suite — pins the QuickPick wiring and
// the cmd.diff alias retarget so Wave 1 alias remains consistent with Wave 3.
//
// -----------------------------------------------------------------------------

const ALIASES_TS_PATH = path.resolve(process.cwd(), 'src/commands/aliases.ts');
const ALIASES_SOURCE = fsSync.readFileSync(ALIASES_TS_PATH, 'utf-8');

suite('Phase 4.3 Wave 3 — versioncon.diff QuickPick (SC-5)', () => {
  test('versioncon.diff command is registered (distinct from versioncon.previewDiff)', () => {
    assert.match(
      EXTENSION_SOURCE,
      /registerCommand\(\s*['"]versioncon\.diff['"]/,
      'expected vscode.commands.registerCommand("versioncon.diff", ...)',
    );
    // Existing per-file previewDiff command MUST remain — coexists with the new diff.
    assert.match(
      EXTENSION_SOURCE,
      /registerCommand\(\s*['"]versioncon\.previewDiff['"]/,
      'existing versioncon.previewDiff registration must remain (per-file context menu)',
    );
  });

  test('versioncon.diff builds a QuickPick from differ.diff().allChanged', () => {
    // The handler must run WorkspaceDiffer.diff() and feed its allChanged
    // list into showQuickPick. We assert the two parts in order.
    const diffIdx = EXTENSION_SOURCE.indexOf("registerCommand('versioncon.diff'");
    assert.ok(diffIdx >= 0, 'versioncon.diff registration not found');
    const block = EXTENSION_SOURCE.slice(diffIdx, diffIdx + 4000);
    assert.match(
      block,
      /new\s+WorkspaceDiffer\(\)/,
      'versioncon.diff body must instantiate WorkspaceDiffer',
    );
    assert.match(
      block,
      /showQuickPick\(/,
      'versioncon.diff body must call vscode.window.showQuickPick',
    );
    assert.match(
      block,
      /allChanged\.map/,
      'versioncon.diff must build items via diff.allChanged.map(...)',
    );
  });

  test('versioncon.diff opens vscode.diff with branch and workspace URIs on pick', () => {
    const diffIdx = EXTENSION_SOURCE.indexOf("registerCommand('versioncon.diff'");
    assert.ok(diffIdx >= 0);
    const block = EXTENSION_SOURCE.slice(diffIdx, diffIdx + 4000);
    assert.match(
      block,
      /executeCommand\(\s*['"]vscode\.diff['"][\s\S]{0,400}?Uri\.file\(\s*branchPath\s*\)/,
      'expected vscode.diff invocation with Uri.file(branchPath) as the original side',
    );
  });

  test('versioncon.diff handles empty changes gracefully via showInformationMessage', () => {
    const diffIdx = EXTENSION_SOURCE.indexOf("registerCommand('versioncon.diff'");
    assert.ok(diffIdx >= 0);
    const block = EXTENSION_SOURCE.slice(diffIdx, diffIdx + 4000);
    assert.match(
      block,
      /if\s*\(\s*diff\.allChanged\.length\s*===\s*0\s*\)[\s\S]{0,200}?showInformationMessage/,
      'empty diff must show an information message and return (no QuickPick on zero changes)',
    );
  });

  test('cmd.diff alias retargeted to versioncon.diff (not versioncon.previewDiff)', () => {
    // Wave 1 set cmd.diff → previewDiff; Wave 3 retargets to the workspace-
    // wide versioncon.diff command. The pre-existing per-file previewDiff
    // alias is removed from cmd.diff (previewDiff stays as its own command).
    assert.match(
      ALIASES_SOURCE,
      /['"]versioncon\.cmd\.diff['"][\s\S]{0,200}executeCommand\(\s*['"]versioncon\.diff['"]\s*\)/,
      'cmd.diff alias must route to versioncon.diff (Wave 3 retarget)',
    );
    // Sanity: cmd.diff must NOT still point at previewDiff.
    const cmdDiffIdx = ALIASES_SOURCE.indexOf("'versioncon.cmd.diff'");
    assert.ok(cmdDiffIdx >= 0);
    const cmdDiffBlock = ALIASES_SOURCE.slice(cmdDiffIdx, cmdDiffIdx + 200);
    assert.doesNotMatch(
      cmdDiffBlock,
      /executeCommand\(\s*['"]versioncon\.previewDiff['"]/,
      'cmd.diff must no longer route to versioncon.previewDiff',
    );
  });
});
