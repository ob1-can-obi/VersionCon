import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Result of comparing the workspace tree against the active branch tree.
 *
 * All paths in DiffResult are POSIX-style relative paths (forward slashes
 * regardless of host OS), mirroring the PresenceInfo convention used
 * elsewhere in the codebase (see src/types/chat.ts).
 *
 * `allChanged` is the union of added + modified + deleted, sorted
 * lexicographically — feed it straight into PushService.executePush as
 * the staged-paths list (see Phase 4.3 SC-3 auto-stage path).
 */
export interface DiffResult {
  /** Files present in the workspace but not in the branch dir. */
  added: string[];
  /** Files present in both trees with different bytes. */
  modified: string[];
  /** Files present in the branch dir but not in the workspace. */
  deleted: string[];
  /** Union of added ∪ modified ∪ deleted, sorted lexicographically. */
  allChanged: string[];
}

/**
 * Directories that are NEVER included in a diff regardless of caller wishes.
 * Mirrors the SPEC §"Workspace-diff–driven push/pull (no drag-required)"
 * exclusion list: `.versioncon/`, `.vscode/`, common ignore patterns.
 *
 * Matching is done by the directory's base name at ANY depth — `.git/`
 * inside a deeply nested subtree is also skipped.
 */
const DEFAULT_IGNORE_DIRS = new Set<string>([
  '.versioncon',
  '.vscode',
  'node_modules',
  'dist',
  '.git',
]);

/**
 * Files that are NEVER included regardless of depth (basename match).
 * Currently only `.DS_Store` per SPEC.
 */
const DEFAULT_IGNORE_FILES = new Set<string>([
  '.DS_Store',
]);

/**
 * Computes the set of files that differ between the user's workspace and
 * the active branch directory. Pure service — takes two absolute paths and
 * has no knowledge of FileSystemLayer, BranchManager, or any VS Code APIs.
 *
 * Used by:
 *   - `versioncon.push` (SC-3): when nothing is drag-staged, allChanged
 *     becomes the staged-paths list fed into PushService.executePush.
 *   - `versioncon.pull` (SC-4): added + modified candidates are pulled
 *     from the branch into the workspace, with per-file conflict prompt.
 *
 * Diff strategy is a pure byte compare via `Buffer.equals(...)` — same
 * approach as the existing sync command's PUSH-11 byte-compare at
 * extension.ts ~2314. No text-mode normalization, no line-diff: a file
 * is "modified" iff its raw bytes differ.
 *
 * Threat model:
 *   - T-04.3-07 mitigation: exclusion list is hard-coded; cannot be bypassed.
 *   - T-04.3-08 (DoS) accepted for v1: pathological multi-million-file
 *     workspaces are out of scope (Phase 5 will add chunked diff).
 */
export class WorkspaceDiffer {
  /**
   * Compute the diff. Returns empty arrays on identical trees, and never
   * throws on a missing root (treats it as an empty listing on that side).
   *
   * @param projectRoot   Absolute path to the workspace directory.
   * @param branchDir     Absolute path to `.versioncon/branches/{active}/`.
   * @param extraIgnoreGlobs  Substring patterns matched against the relative
   *                          path; any match excludes the entry. Substring
   *                          match (not full glob) is the v1 SPEC scope —
   *                          callers wanting glob semantics should normalize
   *                          before passing.
   */
  async diff(
    projectRoot: string,
    branchDir: string,
    extraIgnoreGlobs: string[] = [],
  ): Promise<DiffResult> {
    const wsFiles = await this.listFiles(projectRoot, extraIgnoreGlobs);
    const branchFiles = await this.listFiles(branchDir, extraIgnoreGlobs);

    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    // Iterate workspace side: each entry is either added (not in branch) or
    // present-in-both (compare bytes → modified or skip).
    for (const [rel, wsAbs] of wsFiles) {
      const branchAbs = branchFiles.get(rel);
      if (branchAbs === undefined) {
        added.push(rel);
        continue;
      }
      const [wBuf, bBuf] = await Promise.all([
        fs.readFile(wsAbs),
        fs.readFile(branchAbs),
      ]);
      if (!wBuf.equals(bBuf)) {
        modified.push(rel);
      }
    }

    // Iterate branch side: anything not in the workspace is deleted upstream.
    for (const rel of branchFiles.keys()) {
      if (!wsFiles.has(rel)) {
        deleted.push(rel);
      }
    }

    added.sort();
    modified.sort();
    deleted.sort();
    const allChanged = [...added, ...modified, ...deleted].sort();

    return { added, modified, deleted, allChanged };
  }

  /**
   * Walk `root` depth-first and return a map of POSIX-style relative path
   * → absolute path. Returns an empty map if `root` does not exist or is
   * not a directory — callers downstream interpret a missing tree as
   * "nothing on that side", which is what `diff()` needs for both the
   * missing-branch and missing-workspace edge cases.
   *
   * Excludes:
   *   - any directory whose basename is in DEFAULT_IGNORE_DIRS, at any depth
   *   - any file whose basename is in DEFAULT_IGNORE_FILES, at any depth
   *   - any entry whose relative path (POSIX) contains a substring from
   *     `extraIgnore` (substring match — v1 SPEC scope)
   */
  private async listFiles(
    root: string,
    extraIgnore: string[],
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    const exists = await this.isDirectory(root);
    if (!exists) return result;

    await this.walk(root, '', result, extraIgnore);
    return result;
  }

  /** Depth-first walk helper. `relPrefix` is the POSIX path from `root`. */
  private async walk(
    rootAbs: string,
    relPrefix: string,
    out: Map<string, string>,
    extraIgnore: string[],
  ): Promise<void> {
    const here = relPrefix === '' ? rootAbs : path.join(rootAbs, ...relPrefix.split('/'));
    const entries = await fs.readdir(here, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name)) continue;
        const childRel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`;
        if (this.matchesExtraIgnore(childRel, extraIgnore)) continue;
        await this.walk(rootAbs, childRel, out, extraIgnore);
      } else if (entry.isFile()) {
        if (DEFAULT_IGNORE_FILES.has(entry.name)) continue;
        const childRel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`;
        if (this.matchesExtraIgnore(childRel, extraIgnore)) continue;
        out.set(childRel, path.join(here, entry.name));
      }
      // Skip symlinks, sockets, etc. — out of scope for v1.
    }
  }

  /** True if any extra-ignore substring is contained in `rel`. */
  private matchesExtraIgnore(rel: string, extraIgnore: string[]): boolean {
    if (extraIgnore.length === 0) return false;
    for (const needle of extraIgnore) {
      if (needle.length > 0 && rel.includes(needle)) return true;
    }
    return false;
  }

  /** True iff `p` exists and is a directory. */
  private async isDirectory(p: string): Promise<boolean> {
    try {
      const st = await fs.stat(p);
      return st.isDirectory();
    } catch {
      return false;
    }
  }
}
