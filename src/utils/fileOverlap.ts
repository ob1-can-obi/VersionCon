import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Compute which files a push touched that the user currently has open.
 *
 * Path normalization rules (per Phase 4 RESEARCH §"Path normalization rules"):
 *   - Both inputs are converted to posix forward-slash form
 *   - Lowercased on case-insensitive filesystems (darwin, win32)
 *   - Linux is case-sensitive — no lowercasing applied
 *   - Open-tab paths that resolve OUTSIDE the workspace (relative path
 *     starting with `..`) are excluded from the comparison set
 *
 * The returned `overlapping` and `unaffected` arrays preserve the ORIGINAL
 * case of the input `pushedFiles` so callers can render them verbatim in
 * notifications. Comparison itself is normalized; display is not.
 *
 * Pure function — no I/O, no VS Code API access. The `platform` argument
 * is injectable so tests can fake `darwin` / `linux` / `win32` regardless
 * of the host platform the test suite runs on.
 *
 * Complexity: O(N + M) where N = openTabFsPaths.length and M = pushedFiles.length.
 *
 * @param pushedFiles Workspace-relative paths from PushFileEntry.relativePath.
 * @param openTabFsPaths Absolute fs paths from VS Code tab groups (use {@link getOpenTabPaths}).
 * @param workspaceRootFsPath Absolute path of the workspace root.
 * @param platform `process.platform` — defaults to the current process; tests inject explicitly.
 * @returns `{ overlapping, unaffected }` — pushed files split by whether the user has them open.
 */
export function computeFileOverlap(
  pushedFiles: string[],
  openTabFsPaths: string[],
  workspaceRootFsPath: string,
  platform: NodeJS.Platform = process.platform,
): { overlapping: string[]; unaffected: string[] } {
  const isCaseInsensitive = platform === 'darwin' || platform === 'win32';
  const norm = (p: string): string => {
    // Convert any OS-native separator (\\ on Windows, / on POSIX) to posix /.
    // Splitting on path.sep handles the runtime platform's native separator;
    // additionally splitting on '\\' handles win32-style inputs encountered
    // when running on a posix host (e.g., the win32 unit test feeding
    // 'C:\\Users\\…' on macOS).
    const posixed = p.split(path.sep).join('/').split('\\').join('/');
    return isCaseInsensitive ? posixed.toLowerCase() : posixed;
  };

  // Pick the path module that matches the target platform so workspace-relative
  // computation works correctly when a test runs on a different host than the
  // platform argument it passes (e.g., win32 test on macOS CI).
  const pathLib = platform === 'win32' ? path.win32 : path.posix;

  const openSet = new Set<string>(
    openTabFsPaths
      .map((abs) => pathLib.relative(workspaceRootFsPath, abs))
      .filter((rel) => !rel.startsWith('..')) // outside workspace = ignore
      .map(norm),
  );

  const overlapping: string[] = [];
  const unaffected: string[] = [];
  for (const f of pushedFiles) {
    if (openSet.has(norm(f))) {
      overlapping.push(f);
    } else {
      unaffected.push(f);
    }
  }
  return { overlapping, unaffected };
}

/**
 * Collect all currently-open file paths from VS Code's tab groups.
 *
 * Inclusions:
 *  - `TabInputText` (regular text editor)
 *  - `TabInputTextDiff` (Phase 3 push-preview diff editor) — counts BOTH the
 *    original and the modified URI per RESEARCH §"Edge cases" (the user
 *    clearly cares about both files visible in the diff view).
 *
 * Exclusions:
 *  - Webview tabs (chat panel, sidebar, wizard)
 *  - Terminal tabs
 *  - Output tabs
 *  - Anything not matching the two `TabInput*` types above
 *
 * Untitled drafts (`uri.scheme === 'untitled'`) are intentionally still
 * included — `fsPath` returns the proposed save path and the downstream
 * workspace-boundary filter in {@link computeFileOverlap} naturally excludes
 * paths that don't resolve under the workspace root.
 *
 * Dedupes via `Set` so a file open in multiple tab groups counts once.
 *
 * Touches `vscode.window.tabGroups` — not pure; not unit-testable without
 * mocking the VS Code API. Plan 04-09's integration test exercises this via
 * a real VS Code Electron test run.
 */
export function getOpenTabPaths(): string[] {
  const paths = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputText) {
        paths.add(input.uri.fsPath);
      } else if (input instanceof vscode.TabInputTextDiff) {
        paths.add(input.original.fsPath);
        paths.add(input.modified.fsPath);
      }
    }
  }
  return Array.from(paths);
}
