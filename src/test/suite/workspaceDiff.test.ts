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
