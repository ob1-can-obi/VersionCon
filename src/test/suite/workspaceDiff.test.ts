import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

import { WorkspaceDiffer } from '../../services/WorkspaceDiffer.js';

// -----------------------------------------------------------------------------
// Phase 4.3 Wave 2 — WorkspaceDiffer
//
// Behavior tests for the pure WorkspaceDiffer service. Uses tmpdir-backed
// scratch directories so we exercise real fs/promises I/O end-to-end. Each
// test creates a fresh scratch and tears down on completion.
// -----------------------------------------------------------------------------

async function makeScratch(): Promise<{ workspace: string; branch: string; cleanup: () => Promise<void> }> {
  const tag = crypto.randomBytes(4).toString('hex');
  const root = path.join(os.tmpdir(), `versioncon-workspace-diff-${tag}`);
  const workspace = path.join(root, 'workspace');
  const branch = path.join(root, 'branch');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(branch, { recursive: true });
  return {
    workspace,
    branch,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

async function writeFile(absDir: string, rel: string, content: string): Promise<void> {
  const abs = path.join(absDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

suite('Phase 4.3 Wave 2 — WorkspaceDiffer', () => {
  test('diff() classifies a new workspace file as added', async () => {
    const { workspace, branch, cleanup } = await makeScratch();
    try {
      await writeFile(workspace, 'a.ts', 'hello');

      const diff = await new WorkspaceDiffer().diff(workspace, branch);

      assert.deepStrictEqual(diff.added, ['a.ts']);
      assert.deepStrictEqual(diff.modified, []);
      assert.deepStrictEqual(diff.deleted, []);
      assert.deepStrictEqual(diff.allChanged, ['a.ts']);
    } finally {
      await cleanup();
    }
  });

  test('diff() returns empty arrays when workspace and branch are identical', async () => {
    const { workspace, branch, cleanup } = await makeScratch();
    try {
      await writeFile(workspace, 'a.ts', 'same');
      await writeFile(branch, 'a.ts', 'same');
      await writeFile(workspace, 'src/index.ts', 'identical');
      await writeFile(branch, 'src/index.ts', 'identical');

      const diff = await new WorkspaceDiffer().diff(workspace, branch);

      assert.deepStrictEqual(diff.added, []);
      assert.deepStrictEqual(diff.modified, []);
      assert.deepStrictEqual(diff.deleted, []);
      assert.deepStrictEqual(diff.allChanged, []);
    } finally {
      await cleanup();
    }
  });

  test('diff() classifies a byte-different file as modified', async () => {
    const { workspace, branch, cleanup } = await makeScratch();
    try {
      await writeFile(workspace, 'a.ts', 'workspace version');
      await writeFile(branch, 'a.ts', 'branch version');

      const diff = await new WorkspaceDiffer().diff(workspace, branch);

      assert.deepStrictEqual(diff.modified, ['a.ts']);
      assert.deepStrictEqual(diff.added, []);
      assert.deepStrictEqual(diff.deleted, []);
      assert.deepStrictEqual(diff.allChanged, ['a.ts']);
    } finally {
      await cleanup();
    }
  });

  test('diff() classifies a file present only in branch as deleted', async () => {
    const { workspace, branch, cleanup } = await makeScratch();
    try {
      await writeFile(branch, 'a.ts', 'gone');

      const diff = await new WorkspaceDiffer().diff(workspace, branch);

      assert.deepStrictEqual(diff.deleted, ['a.ts']);
      assert.deepStrictEqual(diff.added, []);
      assert.deepStrictEqual(diff.modified, []);
      assert.deepStrictEqual(diff.allChanged, ['a.ts']);
    } finally {
      await cleanup();
    }
  });

  test('diff() excludes default ignore dirs and files in both trees', async () => {
    const { workspace, branch, cleanup } = await makeScratch();
    try {
      // Files that SHOULD be excluded.
      await writeFile(workspace, '.versioncon/state.json', 'internal');
      await writeFile(workspace, '.vscode/settings.json', 'editor');
      await writeFile(workspace, 'node_modules/lib/index.js', 'dep');
      await writeFile(workspace, 'dist/bundle.js', 'build');
      await writeFile(workspace, '.git/HEAD', 'ref');
      await writeFile(workspace, '.DS_Store', '\0');
      // Same on branch side — must also be ignored even when both sides have them.
      await writeFile(branch, '.versioncon/state.json', 'internal-branch');
      await writeFile(branch, '.vscode/settings.json', 'editor-branch');
      await writeFile(branch, 'node_modules/lib/index.js', 'dep-branch');
      await writeFile(branch, 'dist/bundle.js', 'build-branch');
      await writeFile(branch, '.git/HEAD', 'ref-branch');
      await writeFile(branch, '.DS_Store', '\0');
      // A legit file that should be reported.
      await writeFile(workspace, 'src/index.ts', 'real');

      const diff = await new WorkspaceDiffer().diff(workspace, branch);

      assert.deepStrictEqual(diff.added, ['src/index.ts']);
      assert.deepStrictEqual(diff.modified, []);
      assert.deepStrictEqual(diff.deleted, []);
      // None of the excluded paths should appear anywhere.
      for (const arr of [diff.added, diff.modified, diff.deleted, diff.allChanged]) {
        for (const rel of arr) {
          assert.ok(!rel.startsWith('.versioncon'), `unexpected .versioncon entry: ${rel}`);
          assert.ok(!rel.startsWith('.vscode'), `unexpected .vscode entry: ${rel}`);
          assert.ok(!rel.startsWith('node_modules'), `unexpected node_modules entry: ${rel}`);
          assert.ok(!rel.startsWith('dist'), `unexpected dist entry: ${rel}`);
          assert.ok(!rel.startsWith('.git'), `unexpected .git entry: ${rel}`);
          assert.notStrictEqual(rel, '.DS_Store', `unexpected .DS_Store entry: ${rel}`);
        }
      }
    } finally {
      await cleanup();
    }
  });

  test('diff() recurses into subdirectories and emits POSIX-separated relative paths', async () => {
    const { workspace, branch, cleanup } = await makeScratch();
    try {
      await writeFile(workspace, 'src/foo.ts', 'foo');
      await writeFile(workspace, 'src/sub/bar.ts', 'bar');

      const diff = await new WorkspaceDiffer().diff(workspace, branch);

      assert.ok(diff.added.includes('src/foo.ts'), `expected src/foo.ts in added, got ${JSON.stringify(diff.added)}`);
      assert.ok(diff.added.includes('src/sub/bar.ts'), `expected src/sub/bar.ts in added, got ${JSON.stringify(diff.added)}`);
      // Guard: no backslashes in any reported path (POSIX separator only).
      for (const rel of diff.allChanged) {
        assert.ok(!rel.includes('\\'), `unexpected backslash in: ${rel}`);
      }
    } finally {
      await cleanup();
    }
  });

  test('diff() respects extraIgnoreGlobs (substring match on relative path)', async () => {
    const { workspace, branch, cleanup } = await makeScratch();
    try {
      await writeFile(workspace, 'src/secret.ts', 'shh');
      await writeFile(workspace, 'src/public.ts', 'open');

      const diff = await new WorkspaceDiffer().diff(workspace, branch, ['secret']);

      assert.ok(!diff.allChanged.includes('src/secret.ts'), 'secret should be ignored');
      assert.ok(diff.allChanged.includes('src/public.ts'), 'public should be reported');
    } finally {
      await cleanup();
    }
  });

  test('diff() returns relative paths sorted lexicographically (deterministic)', async () => {
    const { workspace, branch, cleanup } = await makeScratch();
    try {
      // Write in non-alphabetical order so any sort-by-insertion bug would surface.
      await writeFile(workspace, 'zeta.ts', 'z');
      await writeFile(workspace, 'alpha.ts', 'a');
      await writeFile(workspace, 'middle/nested.ts', 'n');
      await writeFile(workspace, 'beta.ts', 'b');

      const diff = await new WorkspaceDiffer().diff(workspace, branch);

      const sortedCopy = [...diff.allChanged].sort();
      assert.deepStrictEqual(diff.allChanged, sortedCopy, 'allChanged must be lexicographically sorted');
      // Same invariant on each bucket.
      assert.deepStrictEqual(diff.added, [...diff.added].sort());
      assert.deepStrictEqual(diff.modified, [...diff.modified].sort());
      assert.deepStrictEqual(diff.deleted, [...diff.deleted].sort());
    } finally {
      await cleanup();
    }
  });

  test('diff() tolerates missing branch dir (whole workspace listed as added) and missing workspace dir (whole branch listed as deleted)', async () => {
    // Case 1: missing branch dir.
    const a = await makeScratch();
    try {
      await fs.rm(a.branch, { recursive: true, force: true });
      await writeFile(a.workspace, 'only.ts', 'x');

      const diff = await new WorkspaceDiffer().diff(a.workspace, a.branch);

      assert.deepStrictEqual(diff.added, ['only.ts']);
      assert.deepStrictEqual(diff.modified, []);
      assert.deepStrictEqual(diff.deleted, []);
    } finally {
      await a.cleanup();
    }

    // Case 2: missing workspace dir.
    const b = await makeScratch();
    try {
      await fs.rm(b.workspace, { recursive: true, force: true });
      await writeFile(b.branch, 'only.ts', 'x');

      const diff = await new WorkspaceDiffer().diff(b.workspace, b.branch);

      assert.deepStrictEqual(diff.deleted, ['only.ts']);
      assert.deepStrictEqual(diff.added, []);
      assert.deepStrictEqual(diff.modified, []);
    } finally {
      await b.cleanup();
    }
  });
});

// -----------------------------------------------------------------------------
// Phase 4.3 Wave 2 — vc push auto-stage fallback (SC-3)
//
// Source-grep suite — pins the wiring in src/extension.ts. Each test reads
// the file once at module init and asserts on structural patterns that must
// remain true for SC-3 to hold (auto-stage path present, permission gates
// still in place, drag-staged path preserved).
// -----------------------------------------------------------------------------

import * as fsSync from 'fs';

suite('Phase 4.3 Wave 2 — vc push auto-stage fallback (SC-3)', () => {
  // Lazy-load source at suiteSetup time so process.cwd() is resolved inside
  // the VS Code extension host (where cwd is the project root) rather than
  // at module-load time (where cwd may be the VS Code application directory).
  let EXTENSION_SOURCE: string;
  suiteSetup(() => {
    const EXTENSION_TS_PATH = path.resolve(process.cwd(), 'src/extension.ts');
    EXTENSION_SOURCE = fsSync.readFileSync(EXTENSION_TS_PATH, 'utf-8');
  });

  test('extension.ts imports WorkspaceDiffer from the services barrel', () => {
    assert.match(
      EXTENSION_SOURCE,
      /import\s*\{\s*WorkspaceDiffer\s*\}\s*from\s*['"]\.\/services\/WorkspaceDiffer\.js['"]/,
      'expected `import { WorkspaceDiffer } from "./services/WorkspaceDiffer.js"` near the top of extension.ts',
    );
  });

  test('versioncon.push fallback runs WorkspaceDiffer when nothing is drag-staged', () => {
    // The literal staged-empty branch must construct a WorkspaceDiffer,
    // call .diff() against workspaceFolder.uri.fsPath + fsLayer.getBranchDir(),
    // assign diff.allChanged to stagedPaths, and flip autoStaged = true.
    assert.match(
      EXTENSION_SOURCE,
      /if\s*\(\s*staged\.length\s*===\s*0\s*\)\s*\{[\s\S]{0,1500}new\s+WorkspaceDiffer\(\)[\s\S]{0,1500}differ\.diff\([\s\S]{0,800}stagedPaths\s*=\s*diff\.allChanged[\s\S]{0,200}autoStaged\s*=\s*true/,
      'expected the staged.length === 0 block to build a WorkspaceDiffer, call differ.diff(), and assign diff.allChanged to stagedPaths with autoStaged = true',
    );
    // Also pin the specific args passed to differ.diff() so the wiring is concrete.
    assert.match(
      EXTENSION_SOURCE,
      /differ\.diff\(\s*workspaceFolder\.uri\.fsPath\s*,\s*fsLayer\.getBranchDir\(\)\s*,?\s*\)/,
      'expected differ.diff(workspaceFolder.uri.fsPath, fsLayer.getBranchDir()) call',
    );
  });

  test('versioncon.push preserves the drag-staged path in the else branch', () => {
    assert.match(
      EXTENSION_SOURCE,
      /\}\s*else\s*\{\s*stagedPaths\s*=\s*staged\.map\(\s*s\s*=>\s*s\.path\s*\)\s*;\s*\}/,
      'expected `else { stagedPaths = staged.map(s => s.path); }` branch to remain in place',
    );
  });

  test('versioncon.push retains permission gates after the auto-stage block', () => {
    // The auto-stage block sits BEFORE the permission checks; we assert the
    // canPushToBranch call still exists somewhere after the autoStaged
    // assignment so a future refactor cannot accidentally short-circuit it.
    const autoStagedIdx = EXTENSION_SOURCE.indexOf('autoStaged = true');
    assert.ok(autoStagedIdx >= 0, 'autoStaged = true marker not found — auto-stage block missing');
    const tail = EXTENSION_SOURCE.slice(autoStagedIdx);
    assert.match(
      tail,
      /permissions\.canPushToBranch\(\s*currentMemberId\s*,\s*branch\s*\)/,
      'permissions.canPushToBranch(currentMemberId, branch) must appear after the auto-stage block',
    );
  });
});

// -----------------------------------------------------------------------------
// Phase 4.3 Wave 2 — vc pull (SC-4)
//
// Source-grep suite — pins the new versioncon.pull handler in extension.ts
// and the cmd.pull alias retarget in src/commands/aliases.ts.
// -----------------------------------------------------------------------------

suite('Phase 4.3 Wave 2 — vc pull (SC-4)', () => {
  // Lazy-load source files at suiteSetup time (same rationale as SC-3 suite:
  // process.cwd() is the project root inside the VS Code extension host, not
  // at module-load time where cwd may be the VS Code application directory).
  let EXTENSION_SOURCE_PULL: string;
  let ALIASES_SOURCE: string;
  suiteSetup(() => {
    EXTENSION_SOURCE_PULL = fsSync.readFileSync(
      path.resolve(process.cwd(), 'src/extension.ts'), 'utf-8',
    );
    ALIASES_SOURCE = fsSync.readFileSync(
      path.resolve(process.cwd(), 'src/commands/aliases.ts'), 'utf-8',
    );
  });

  /**
   * Returns the byte range of the versioncon.pull handler block in
   * extension.ts — from the registerCommand opener to the matching `}),`.
   * Used so tests can scope assertions to the pull handler ONLY (the file
   * also contains the existing versioncon.sync handler with similar shape,
   * so naive substring matches would conflict).
   */
  function pullHandlerBlock(): string {
    const startMarker = "registerCommand('versioncon.pull'";
    const startIdx = EXTENSION_SOURCE_PULL.indexOf(startMarker);
    assert.ok(startIdx >= 0, 'expected registerCommand("versioncon.pull") in extension.ts');
    // Conservative end-of-block sentinel: the closing "}),\n      );" that
    // closes the subscriptions.push wrapper. There is exactly one such
    // sequence following the pull handler's body before the next comment.
    const endIdx = EXTENSION_SOURCE_PULL.indexOf('}),\n      );', startIdx);
    assert.ok(endIdx > startIdx, 'expected `}),\\n      );` closer for the versioncon.pull handler');
    return EXTENSION_SOURCE_PULL.slice(startIdx, endIdx + 14);
  }

  test('extension.ts registers versioncon.pull as a dedicated command', () => {
    assert.match(
      EXTENSION_SOURCE_PULL,
      /registerCommand\(\s*'versioncon\.pull'\s*,\s*async\s*\(\s*\)\s*=>/,
      'expected registerCommand("versioncon.pull", async () => ...) in extension.ts',
    );
    // versioncon.sync MUST still exist — pull and sync are separate commands.
    assert.match(
      EXTENSION_SOURCE_PULL,
      /registerCommand\(\s*'versioncon\.sync'\s*,/,
      'versioncon.sync handler must still exist alongside the new versioncon.pull',
    );
  });

  test('versioncon.pull reuses the PUSH-11 conflict prompt literals verbatim', () => {
    const block = pullHandlerBlock();
    assert.ok(
      block.includes("'Keep mine'"),
      'pull handler must include the "Keep mine" PUSH-11 option literal',
    );
    assert.ok(
      block.includes("'Take branch'"),
      'pull handler must include the "Take branch" PUSH-11 option literal',
    );
    assert.ok(
      block.includes("'Show diff'"),
      'pull handler must include the "Show diff" PUSH-11 option literal',
    );
    // Also confirm the modal-detail message literal matches the sync handler's
    // wording — T-04.3-06 mitigation depends on a faithful reuse.
    assert.ok(
      block.includes('The branch has a different version of this file than your workspace. Choose how to resolve:'),
      'pull handler must reuse the PUSH-11 modal detail wording verbatim',
    );
  });

  test('versioncon.pull v1 documents that branch-side deletions are NOT propagated', () => {
    const block = pullHandlerBlock();
    assert.match(
      block,
      /vc\.pull v1[\s\S]{0,200}branch-side deletions[\s\S]{0,200}NOT propagated/,
      'pull handler must document the v1 scope decision that branch-side deletions are not propagated to the workspace',
    );
  });

  test('versioncon.cmd.pull alias retargets to versioncon.pull (not versioncon.sync)', () => {
    // The Wave 1 alias used to target versioncon.sync; Wave 2 retargets to
    // the new dedicated versioncon.pull (SC-4 contract). Pin the new mapping.
    assert.match(
      ALIASES_SOURCE,
      /registerCommand\(\s*'versioncon\.cmd\.pull'\s*,[\s\S]{0,200}?executeCommand\(\s*'versioncon\.pull'\s*\)/,
      'aliases.ts must route versioncon.cmd.pull to versioncon.pull (no longer versioncon.sync)',
    );
    // Negative assertion — the OLD mapping must NOT be present anywhere in
    // the cmd.pull registerCommand region (it's fine for other commands to
    // continue calling versioncon.sync from elsewhere in the codebase).
    const cmdPullIdx = ALIASES_SOURCE.indexOf("'versioncon.cmd.pull'");
    assert.ok(cmdPullIdx >= 0, 'cmd.pull declaration missing from aliases.ts');
    const cmdPullSlice = ALIASES_SOURCE.slice(cmdPullIdx, cmdPullIdx + 200);
    assert.ok(
      !/executeCommand\(\s*'versioncon\.sync'\s*\)/.test(cmdPullSlice),
      'cmd.pull must no longer route to versioncon.sync — Wave 2 retargeted it to versioncon.pull',
    );
  });
});
