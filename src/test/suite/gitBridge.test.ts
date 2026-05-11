import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { spawn } from 'child_process';

import { GitBridge } from '../../services/GitBridge.js';

// -----------------------------------------------------------------------------
// Phase 4.3 Wave 4 — GitBridge validators (T-04.3-03)
//
// Allowlist regex enforcement is the FIRST line of defense against command
// injection. Each validate* method must:
//   * accept the documented allowlist forms
//   * reject any string containing shell metacharacters
//   * reject empty/oversize input
// -----------------------------------------------------------------------------
suite('Phase 4.3 Wave 4 — GitBridge validators (T-04.3-03)', () => {
  const bridge = new GitBridge();

  test('validateUrl accepts https URL with .git suffix', () => {
    assert.strictEqual(bridge.validateUrl('https://github.com/foo/bar.git'), true);
  });

  test('validateUrl accepts https URL without .git suffix', () => {
    assert.strictEqual(bridge.validateUrl('https://github.com/foo/bar'), true);
  });

  test('validateUrl accepts git@ssh shorthand', () => {
    assert.strictEqual(bridge.validateUrl('git@github.com:foo/bar.git'), true);
  });

  test('validateUrl accepts file:// local bare repo URL', () => {
    assert.strictEqual(bridge.validateUrl('file:///tmp/test-bare.git'), true);
  });

  test('validateUrl rejects URL containing shell metacharacter (semicolon)', () => {
    assert.strictEqual(bridge.validateUrl('https://github.com/foo/bar; rm -rf /'), false);
  });

  test('validateUrl rejects URL containing shell metacharacter (backtick)', () => {
    assert.strictEqual(bridge.validateUrl('https://github.com/`whoami`.git'), false);
  });

  test('validateUrl rejects unsupported scheme (javascript:)', () => {
    assert.strictEqual(bridge.validateUrl('javascript:alert(1)'), false);
  });

  test('validateUrl rejects empty string', () => {
    assert.strictEqual(bridge.validateUrl(''), false);
  });

  test('validateBranchName accepts simple name', () => {
    assert.strictEqual(bridge.validateBranchName('main'), true);
  });

  test('validateBranchName accepts feature/ slash + dot + underscore', () => {
    assert.strictEqual(bridge.validateBranchName('feature/foo-bar.v2_3'), true);
  });

  test('validateBranchName rejects name with shell metacharacter', () => {
    assert.strictEqual(bridge.validateBranchName('foo; rm -rf /'), false);
  });

  test('validateBranchName rejects empty string', () => {
    assert.strictEqual(bridge.validateBranchName(''), false);
  });

  test('validateBranchName rejects names over 128 chars', () => {
    assert.strictEqual(bridge.validateBranchName('a'.repeat(129)), false);
  });
});

// -----------------------------------------------------------------------------
// Phase 4.3 Wave 4 — GitBridge runGit (T-04.3-03)
//
// runGit invokes child_process.spawn with shell:false and an argv array. These
// smoke tests verify the wrapper resolves cleanly on both success and failure
// (no uncaught exception thrown). Tests skip when git is not installed.
// -----------------------------------------------------------------------------
suite('Phase 4.3 Wave 4 — GitBridge runGit (T-04.3-03)', () => {
  const bridge = new GitBridge();
  let gitAvailable = false;

  suiteSetup(async function () {
    this.timeout(5_000);
    try {
      const r = await bridge.runGit(['--version'], os.tmpdir());
      gitAvailable = r.code === 0;
    } catch {
      gitAvailable = false;
    }
    if (!gitAvailable) {
      console.warn('Phase 4.3 Wave 4: git not on PATH — runGit + round-trip tests will skip');
    }
  });

  test('runGit(["--version"]) resolves with code 0 and stdout starting with "git version"', async function () {
    if (!gitAvailable) return this.skip();
    const r = await bridge.runGit(['--version'], os.tmpdir());
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /^git version/);
  });

  test('runGit(["nonexistent-subcommand"]) resolves with non-zero code and non-empty stderr, does not throw', async function () {
    if (!gitAvailable) return this.skip();
    const r = await bridge.runGit(['nonexistent-subcommand-xxx'], os.tmpdir());
    assert.notStrictEqual(r.code, 0);
    // Either stdout or stderr will carry git's "not a git command" message.
    assert.ok(r.stderr.length > 0 || r.stdout.length > 0);
  });
});

// -----------------------------------------------------------------------------
// Phase 4.3 Wave 4 — GitBridge round-trip (SC-6)
//
// End-to-end: create a temp bare repo, populate a branch dir with one file,
// call exportToRemote, and verify `git log` in the bare repo shows the commit.
// Skipped when git is not available.
// -----------------------------------------------------------------------------
suite('Phase 4.3 Wave 4 — GitBridge round-trip (SC-6)', () => {
  const bridge = new GitBridge();
  let gitAvailable = false;

  suiteSetup(async function () {
    this.timeout(5_000);
    try {
      const r = await bridge.runGit(['--version'], os.tmpdir());
      gitAvailable = r.code === 0;
    } catch {
      gitAvailable = false;
    }
  });

  test('exportToRemote against a local bare repo round-trips', async function () {
    if (!gitAvailable) return this.skip();
    this.timeout(30_000);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vc-gitbridge-'));
    const bare = path.join(tmp, 'remote.git');
    const branchDir = path.join(tmp, 'branch');
    try {
      await fs.mkdir(branchDir, { recursive: true });
      await fs.writeFile(path.join(branchDir, 'README.md'), '# v1\n');

      // Set up bare repo via spawn (mirrors what we're testing).
      const bareInit = await bridge.runGit(['init', '--bare', bare], tmp);
      assert.strictEqual(bareInit.code, 0, `bare init failed: ${bareInit.stderr}`);

      const output: string[] = [];

      // Pre-init the branch dir as a repo so we can set local user.email/user.name
      // (CI environments may lack global config).
      await bridge.runGit(['init'], branchDir);
      await bridge.runGit(['config', 'user.email', 'test@example.com'], branchDir);
      await bridge.runGit(['config', 'user.name', 'VersionCon Test'], branchDir);
      // Force the local branch name to 'main' so push -u origin main works
      // regardless of the user's init.defaultBranch.
      await bridge.runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], branchDir);

      await bridge.exportToRemote({
        branchDir,
        remoteUrl: `file://${bare}`,
        branchOnRemote: 'main',
        commitMessage: 'initial commit',
        onOutput: (l: string) => output.push(l),
      });

      const log = await bridge.runGit(['--git-dir', bare, 'log', '--oneline'], tmp);
      assert.strictEqual(log.code, 0, `log failed: ${log.stderr}`);
      assert.match(log.stdout, /initial commit/);
      assert.ok(output.length > 0, 'onOutput should have been invoked');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test('importFromRemote pulls README.md content from a bare repo round-trip', async function () {
    if (!gitAvailable) return this.skip();
    this.timeout(30_000);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vc-gitbridge-import-'));
    const bare = path.join(tmp, 'remote.git');
    const branchDir = path.join(tmp, 'branch');
    const destDir = path.join(tmp, 'imported');
    try {
      await fs.mkdir(branchDir, { recursive: true });
      await fs.writeFile(path.join(branchDir, 'README.md'), '# round-trip\n');

      await bridge.runGit(['init', '--bare', bare], tmp);
      await bridge.runGit(['init'], branchDir);
      await bridge.runGit(['config', 'user.email', 'test@example.com'], branchDir);
      await bridge.runGit(['config', 'user.name', 'VersionCon Test'], branchDir);
      await bridge.runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], branchDir);

      await bridge.exportToRemote({
        branchDir,
        remoteUrl: `file://${bare}`,
        branchOnRemote: 'main',
        commitMessage: 'initial commit',
        onOutput: () => undefined,
      });

      const output: string[] = [];
      await bridge.importFromRemote({
        remoteUrl: `file://${bare}`,
        branchOnRemote: 'main',
        destDir,
        onOutput: (l: string) => output.push(l),
      });

      // Imported tree should contain README.md with original content...
      const readme = await fs.readFile(path.join(destDir, 'README.md'), 'utf-8');
      assert.strictEqual(readme, '# round-trip\n');
      // ...and NOT contain a .git directory (T-04.3-13 mitigation — stripped post-clone).
      let gitDirExists = true;
      try {
        await fs.access(path.join(destDir, '.git'));
      } catch {
        gitDirExists = false;
      }
      assert.strictEqual(gitDirExists, false, '.git/ must be stripped from imported dir (T-04.3-13)');
      assert.ok(output.length > 0, 'onOutput should have been invoked');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// Phase 4.3 Wave 4 — GitBridge spawn invariant (T-04.3-03)
//
// Source-grep against src/services/GitBridge.ts to pin the shell:false /
// argv-array invariant. If a future change introduces exec() or execSync(),
// these tests fail loudly — the mitigation is preserved.
// -----------------------------------------------------------------------------
suite('Phase 4.3 Wave 4 — GitBridge spawn invariant (T-04.3-03)', () => {
  const srcPath = path.resolve(process.cwd(), 'src/services/GitBridge.ts');

  test('GitBridge.ts invokes spawn with shell:false explicitly', () => {
    const src = fsSync.readFileSync(srcPath, 'utf-8');
    assert.match(
      src,
      /spawn\([\s\S]{0,200}?shell:\s*false/,
      'spawn() must include `shell: false` within 200 chars of the call site',
    );
  });

  test('GitBridge.ts never calls child_process.exec or execSync (T-04.3-03)', () => {
    const src = fsSync.readFileSync(srcPath, 'utf-8');
    assert.doesNotMatch(
      src,
      /\bexec(?:Sync)?\s*\(/,
      'exec() / execSync() are forbidden — they invoke a shell',
    );
    assert.doesNotMatch(
      src,
      /from\s+['"]child_process['"][^;]*\b(?:exec|execSync)\b/,
      'exec / execSync must not be imported from child_process',
    );
  });

  test('GitBridge.ts is a real module that exports GitBridge', () => {
    const src = fsSync.readFileSync(srcPath, 'utf-8');
    assert.match(src, /export\s+class\s+GitBridge\b/);
  });
});

// -----------------------------------------------------------------------------
// Phase 4.3 Wave 4 — exportToGitRemote wiring (SC-6 / T-04.3-04)
//
// Source-grep against src/extension.ts + package.json to pin the wiring:
//   * import of GitBridge
//   * registration of versioncon.exportToGitRemote inside the workspace IIFE
//   * two-layer permission gate: !activeHost AND !permissions.canCreateBranch
//   * URL + branch-name validation via gitBridge.validateUrl / validateBranchName
//   * confirmation modal (T-04.3-02) before exportToRemote() invocation
//   * dedicated Output channel 'VersionCon: Git Bridge'
//   * error path catches GitBridge errors with showErrorMessage
// -----------------------------------------------------------------------------
suite('Phase 4.3 Wave 4 — exportToGitRemote wiring (SC-6 / T-04.3-04)', () => {
  const extPath = path.resolve(process.cwd(), 'src/extension.ts');
  const pkgPath = path.resolve(process.cwd(), 'package.json');

  test('extension.ts imports GitBridge from ./services/GitBridge.js', () => {
    const src = fsSync.readFileSync(extPath, 'utf-8');
    assert.match(
      src,
      /import\s*\{\s*GitBridge\s*\}\s*from\s*['"]\.\/services\/GitBridge\.js['"]/,
      'extension.ts must import GitBridge from ./services/GitBridge.js',
    );
  });

  test('extension.ts registers versioncon.exportToGitRemote command', () => {
    const src = fsSync.readFileSync(extPath, 'utf-8');
    assert.match(
      src,
      /registerCommand\(\s*['"]versioncon\.exportToGitRemote['"]/,
      'extension.ts must register versioncon.exportToGitRemote',
    );
  });

  test('exportToGitRemote handler has !activeHost host-only gate (T-04.3-04)', () => {
    const src = fsSync.readFileSync(extPath, 'utf-8');
    // Find the registerCommand block for exportToGitRemote and inspect it.
    const block = src.match(
      /registerCommand\(\s*['"]versioncon\.exportToGitRemote['"][\s\S]*?\}\),\s*\n\s*\);/,
    );
    assert.ok(block, 'exportToGitRemote registration block must be parseable');
    assert.match(
      block[0],
      /if\s*\(\s*!activeHost\s*\)/,
      'exportToGitRemote handler must early-return when !activeHost (T-04.3-04 host-only gate)',
    );
  });

  test('exportToGitRemote handler has permissions.canCreateBranch admin gate (T-04.3-04)', () => {
    const src = fsSync.readFileSync(extPath, 'utf-8');
    const block = src.match(
      /registerCommand\(\s*['"]versioncon\.exportToGitRemote['"][\s\S]*?\}\),\s*\n\s*\);/,
    );
    assert.ok(block, 'exportToGitRemote registration block must be parseable');
    assert.match(
      block[0],
      /permissions\.canCreateBranch\(currentMemberId\)/,
      'exportToGitRemote handler must check permissions.canCreateBranch(currentMemberId)',
    );
  });

  test('exportToGitRemote prompts for URL using validateUrl', () => {
    const src = fsSync.readFileSync(extPath, 'utf-8');
    const block = src.match(
      /registerCommand\(\s*['"]versioncon\.exportToGitRemote['"][\s\S]*?\}\),\s*\n\s*\);/,
    );
    assert.ok(block);
    assert.match(
      block[0],
      /showInputBox\([\s\S]*?validateInput[\s\S]*?validateUrl/,
      'exportToGitRemote URL prompt must call gitBridge.validateUrl in validateInput',
    );
  });

  test('exportToGitRemote prompts for branch using validateBranchName', () => {
    const src = fsSync.readFileSync(extPath, 'utf-8');
    const block = src.match(
      /registerCommand\(\s*['"]versioncon\.exportToGitRemote['"][\s\S]*?\}\),\s*\n\s*\);/,
    );
    assert.ok(block);
    assert.match(
      block[0],
      /validateBranchName/,
      'exportToGitRemote handler must invoke validateBranchName for the branch input',
    );
  });

  test('exportToGitRemote shows modal confirmation before exportToRemote (T-04.3-02)', () => {
    const src = fsSync.readFileSync(extPath, 'utf-8');
    const block = src.match(
      /registerCommand\(\s*['"]versioncon\.exportToGitRemote['"][\s\S]*?\}\),\s*\n\s*\);/,
    );
    assert.ok(block);
    // Modal confirm must come BEFORE the exportToRemote call.
    const modalIdx = block[0].search(/\{\s*modal:\s*true/);
    const exportIdx = block[0].search(/exportToRemote\s*\(/);
    assert.ok(modalIdx > 0, 'confirmation modal { modal: true } must appear in handler');
    assert.ok(exportIdx > 0, 'exportToRemote(...) must be invoked');
    assert.ok(
      modalIdx < exportIdx,
      'confirmation modal must precede exportToRemote(...) call (T-04.3-02)',
    );
  });

  test('extension.ts creates Output channel exactly "VersionCon: Git Bridge"', () => {
    const src = fsSync.readFileSync(extPath, 'utf-8');
    assert.match(
      src,
      /createOutputChannel\(\s*['"]VersionCon: Git Bridge['"]\s*\)/,
      'extension.ts must create an OutputChannel named exactly "VersionCon: Git Bridge"',
    );
  });

  test('exportToGitRemote handler catches errors and shows showErrorMessage (no crash)', () => {
    const src = fsSync.readFileSync(extPath, 'utf-8');
    const block = src.match(
      /registerCommand\(\s*['"]versioncon\.exportToGitRemote['"][\s\S]*?\}\),\s*\n\s*\);/,
    );
    assert.ok(block);
    assert.match(
      block[0],
      /catch\s*\([\s\S]*?showErrorMessage/,
      'exportToGitRemote handler must catch errors and route through showErrorMessage',
    );
  });

  test('package.json declares versioncon.exportToGitRemote with VersionCon category', () => {
    const src = fsSync.readFileSync(pkgPath, 'utf-8');
    assert.match(
      src,
      /"command"\s*:\s*"versioncon\.exportToGitRemote"[\s\S]{0,200}?"title"\s*:\s*"VersionCon: Export to Git Remote"[\s\S]{0,200}?"category"\s*:\s*"VersionCon"/,
      'package.json must declare versioncon.exportToGitRemote with the SPEC-locked title + category',
    );
  });
});
