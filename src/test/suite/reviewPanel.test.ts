/**
 * Phase 6 Wave 3 (Plan 06-04) — ReviewPanel source-grep + lifecycle suite.
 *
 * Two complementary suites:
 *
 *  1. Source-grep + structure — pins the load-bearing invariants of the
 *     ReviewPanel webview architecture (CSP shape, markdown-it html:false in
 *     both review/main.ts AND chat/main.ts to prevent T-06-02 regression,
 *     CSP placeholder in the HTML template, retainContextWhenHidden, command
 *     registration in package.json + extension.ts, 5 review listeners wired
 *     in BOTH wireClientEvents + wireHostEvents, esbuild copyReviewAssets
 *     + review bundle entry).
 *
 *  2. Lifecycle behavior — exercises ReviewPanel.handleMessage routing via
 *     the typed-bracket-cast harness (same pattern Plan 04-05 uses for
 *     SessionClient.handleMessage), asserting the 4 webview-message types
 *     route to the correct callback / are dropped on invalid shape.
 *     Singleton + dispose tests use a stub WebviewPanel — the createOrShow
 *     path itself requires a VS Code extension host so we exercise it via
 *     a private-constructor bypass for the lifecycle assertions.
 *
 * Mirrors Plan 06-01's "pin current behavior" posture for the source-grep
 * subsuite — these tests do NOT follow a RED phase because they pin
 * implementation that Tasks 1-3 already landed. They exist purely to break
 * the build if Wave 4-5 (or future refactors) drift the shapes.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ReviewPanel } from '../../ui/ReviewPanel.js';
import type { ReviewPanelCallbacks } from '../../ui/ReviewPanel.js';

const repoRoot = process.cwd();
const readSrc = (rel: string): string =>
  fs.readFileSync(path.resolve(repoRoot, rel), 'utf-8');

suite('Phase 6 Wave 3 — ReviewPanel source-grep + structure', () => {
  test('webview review/main.ts uses markdown-it html:false (T-06-02 mitigation)', () => {
    assert.match(readSrc('src/ui/webview/review/main.ts'), /html:\s*false/);
  });

  test('webview chat/main.ts still uses markdown-it html:false (Plan 04-10 regression guard)', () => {
    // T-06-02 lives in BOTH webview entries — drift between them would
    // regress the XSS gate on one panel while keeping the other safe.
    assert.match(readSrc('src/ui/webview/chat/main.ts'), /html:\s*false/);
  });

  test('webview review/index.html declares CSP placeholder', () => {
    const html = readSrc('src/ui/webview/review/index.html');
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /%%CSP%%/);
  });

  test('webview review/index.html links codicon + main.css + main.js nonce', () => {
    const html = readSrc('src/ui/webview/review/index.html');
    assert.match(html, /%%CODICON_CSS_URI%%/);
    assert.match(html, /%%CSS_URI%%/);
    assert.match(html, /%%JS_URI%%/);
    assert.match(html, /nonce="%%NONCE%%"/);
  });

  test('ReviewPanel.ts builds the same strict CSP shape as ChatPanel', () => {
    const s = readSrc('src/ui/ReviewPanel.ts');
    assert.match(s, /default-src 'none'/);
    assert.match(s, /img-src \$\{webview\.cspSource\} data:/);
    assert.match(s, /style-src \$\{webview\.cspSource\} 'nonce-/);
    assert.match(s, /font-src \$\{webview\.cspSource\}/);
    assert.match(s, /script-src 'nonce-/);
  });

  test('ReviewPanel uses retainContextWhenHidden:true + enableScripts:true', () => {
    const s = readSrc('src/ui/ReviewPanel.ts');
    assert.match(s, /retainContextWhenHidden:\s*true/);
    assert.match(s, /enableScripts:\s*true/);
  });

  test('ReviewPanel resolves dist/webview/review/ as localResourceRoots', () => {
    const s = readSrc('src/ui/ReviewPanel.ts');
    assert.match(s, /joinPath\([^)]*'dist',\s*'webview',\s*'review'\)/);
  });

  test('ReviewPanel.openFileDiff invokes vscode.diff with snapshot + branch paths', () => {
    const s = readSrc('src/ui/ReviewPanel.ts');
    assert.match(s, /vscode\.commands\.executeCommand\(\s*'vscode\.diff'/);
    assert.match(s, /push-snapshots/);
    assert.match(s, /branches/);
  });

  test('versioncon.openReview is registered in extension.ts', () => {
    assert.match(
      readSrc('src/extension.ts'),
      /registerCommand\(\s*['"]versioncon\.openReview['"]/,
    );
  });

  test('versioncon.openReview is declared in package.json contributes.commands', () => {
    const pkg = readSrc('package.json');
    assert.match(pkg, /"command":\s*"versioncon\.openReview"/);
    assert.match(pkg, /"title":\s*"VersionCon: Open Review"/);
  });

  test('extension.ts constructs a module-level reviewState via new ReviewState()', () => {
    const s = readSrc('src/extension.ts');
    assert.match(s, /reviewState\s*=\s*new ReviewState\(\)/);
  });

  test('extension.ts wires 5 review listeners in wireClientEvents', () => {
    const s = readSrc('src/extension.ts');
    // Narrow to the wireClientEvents function body — robust to nested
    // braces by capturing from the function header through the last
    // listener block.
    const m = s.match(/function wireClientEvents\b[\s\S]*?\n  \}/);
    assert.ok(m, 'wireClientEvents function not found');
    const block = m![0];
    for (const evt of [
      'review-opened', 'review-comment', 'review-vote',
      'review-resolved', 'review-state-sync',
    ]) {
      assert.ok(
        block.includes(`client.on('${evt}'`),
        `wireClientEvents missing client.on('${evt}') listener`,
      );
    }
  });

  test('extension.ts wires 5 review listeners in wireHostEvents', () => {
    const s = readSrc('src/extension.ts');
    const m = s.match(/function wireHostEvents\b[\s\S]*?\n  \}/);
    assert.ok(m, 'wireHostEvents function not found');
    const block = m![0];
    for (const evt of [
      'review-opened', 'review-comment', 'review-vote',
      'review-resolved', 'review-state-sync',
    ]) {
      assert.ok(
        block.includes(`host.on('${evt}'`),
        `wireHostEvents missing host.on('${evt}') listener`,
      );
    }
  });

  test('SessionHost exposes 4 handleLocalReview* public helpers', () => {
    const s = readSrc('src/host/SessionHost.ts');
    assert.match(s, /async handleLocalReviewOpen\(/);
    assert.match(s, /async handleLocalReviewComment\(/);
    assert.match(s, /async handleLocalReviewVote\(/);
    assert.match(s, /async handleLocalReviewResolved\(/);
  });

  test('SessionHost emits review-* events so extension.ts can mirror peer activity', () => {
    const s = readSrc('src/host/SessionHost.ts');
    assert.match(s, /this\.emit\(\s*'review-opened'/);
    assert.match(s, /this\.emit\(\s*'review-comment'/);
    assert.match(s, /this\.emit\(\s*'review-vote'/);
    assert.match(s, /this\.emit\(\s*'review-resolved'/);
  });

  test('esbuild.config.mjs declares copyReviewAssets function', () => {
    assert.match(
      readSrc('esbuild.config.mjs'),
      /async function copyReviewAssets\(/,
    );
  });

  test('esbuild.config.mjs adds review-main.ts bundle entry', () => {
    assert.match(
      readSrc('esbuild.config.mjs'),
      /src\/ui\/webview\/review\/main\.ts/,
    );
  });

  test('esbuild.config.mjs outputs dist/webview/review/main.js', () => {
    assert.match(
      readSrc('esbuild.config.mjs'),
      /dist\/webview\/review\/main\.js/,
    );
  });

  test('ReviewPanel webview message protocol — 4 inbound types routed', () => {
    const s = readSrc('src/ui/ReviewPanel.ts');
    assert.match(s, /case 'open-file-diff'/);
    assert.match(s, /case 'review-vote-submit'/);
    assert.match(s, /case 'review-comment-submit'/);
    assert.match(s, /case 'review-resolve-submit'/);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle behavior — exercise handleMessage routing via private-bracket cast
// (same pattern as Plan 04-05 SessionClient.handleMessage harness).
// ---------------------------------------------------------------------------

interface HandleMessageProbe {
  handleMessage: (msg: unknown) => Promise<void>;
}

function makeCallbacks(): {
  callbacks: ReviewPanelCallbacks;
  votes: Array<{ reviewId: string; vote: string }>;
  comments: Array<{ reviewId: string; filePath: string; line: number; body: string }>;
  resolves: Array<{ reviewId: string; resolvedReason: string }>;
} {
  const votes: Array<{ reviewId: string; vote: string }> = [];
  const comments: Array<{ reviewId: string; filePath: string; line: number; body: string }> = [];
  const resolves: Array<{ reviewId: string; resolvedReason: string }> = [];
  return {
    callbacks: {
      onVoteRequested: (reviewId, vote) => votes.push({ reviewId, vote }),
      onCommentRequested: (reviewId, filePath, line, body) =>
        comments.push({ reviewId, filePath, line, body }),
      onResolveRequested: (reviewId, resolvedReason) =>
        resolves.push({ reviewId, resolvedReason }),
      getSelfMemberId: () => 'm-self',
      getHostMemberId: () => 'm-host',
    },
    votes, comments, resolves,
  };
}

/**
 * Construct a ReviewPanel via the private constructor using a typed-bracket
 * cast. createOrShow internally creates a vscode.WebviewPanel, which is only
 * available inside the extension host — using it here works because the
 * test suite runs inside the extension host. Caller is responsible for
 * disposing the panel.
 */
function makePanel(callbacks: ReviewPanelCallbacks): ReviewPanel {
  // ReviewPanel.currentPanel is a static singleton — dispose any prior
  // instance first so each test starts from a clean state.
  if (ReviewPanel.currentPanel) {
    ReviewPanel.currentPanel.dispose();
  }
  // Synthesize a minimal ExtensionContext stub — only extensionUri is
  // referenced by the constructor path we exercise (getWebviewContent +
  // localResourceRoots). The webview never actually loads JS here because
  // tests only call handleMessage directly.
  const stubContext = {
    extensionUri: (require('vscode') as typeof import('vscode')).Uri.file(repoRoot),
  } as unknown as import('vscode').ExtensionContext;
  return ReviewPanel.createOrShow(stubContext, 'p-test-123', '/tmp/.versioncon', callbacks);
}

suite('Phase 6 Wave 3 — ReviewPanel lifecycle behavior', () => {
  teardown(() => {
    if (ReviewPanel.currentPanel) {
      ReviewPanel.currentPanel.dispose();
    }
  });

  test('createOrShow returns the same instance on second call with same pushId', () => {
    const { callbacks } = makeCallbacks();
    const a = makePanel(callbacks);
    // Second call with same pushId should reveal the existing panel and
    // return it (singleton invariant).
    const stubContext = {
      extensionUri: (require('vscode') as typeof import('vscode')).Uri.file(repoRoot),
    } as unknown as import('vscode').ExtensionContext;
    const b = ReviewPanel.createOrShow(stubContext, 'p-test-123', '/tmp/.versioncon', callbacks);
    assert.strictEqual(a, b, 'createOrShow with same pushId should return the same instance');
    assert.strictEqual(a.scopedPushId, 'p-test-123');
  });

  test('createOrShow disposes prior panel when pushId differs', () => {
    const { callbacks } = makeCallbacks();
    const a = makePanel(callbacks);
    assert.strictEqual(ReviewPanel.currentPanel, a);
    const stubContext = {
      extensionUri: (require('vscode') as typeof import('vscode')).Uri.file(repoRoot),
    } as unknown as import('vscode').ExtensionContext;
    const b = ReviewPanel.createOrShow(stubContext, 'p-DIFFERENT', '/tmp/.versioncon', callbacks);
    assert.notStrictEqual(a, b, 'createOrShow with different pushId should create a new panel');
    assert.strictEqual(b.scopedPushId, 'p-DIFFERENT');
    assert.strictEqual(ReviewPanel.currentPanel, b);
  });

  test('dispose clears static currentPanel', () => {
    const { callbacks } = makeCallbacks();
    const p = makePanel(callbacks);
    assert.strictEqual(ReviewPanel.currentPanel, p);
    p.dispose();
    assert.strictEqual(ReviewPanel.currentPanel, undefined,
      'static currentPanel should be undefined after dispose');
  });

  test('handleMessage routes review-vote-submit to onVoteRequested', async () => {
    const { callbacks, votes } = makeCallbacks();
    const p = makePanel(callbacks);
    const probe = p as unknown as HandleMessageProbe;
    await probe.handleMessage({
      type: 'review-vote-submit',
      reviewId: 'r-1',
      vote: 'approved',
    });
    assert.strictEqual(votes.length, 1);
    assert.deepStrictEqual(votes[0], { reviewId: 'r-1', vote: 'approved' });
  });

  test('handleMessage rejects review-vote-submit with unknown vote value', async () => {
    const { callbacks, votes } = makeCallbacks();
    const p = makePanel(callbacks);
    const probe = p as unknown as HandleMessageProbe;
    await probe.handleMessage({
      type: 'review-vote-submit',
      reviewId: 'r-1',
      vote: 'lgtm', // not in the allowed set
    });
    assert.strictEqual(votes.length, 0, 'invalid vote value should be silently dropped');
  });

  test('handleMessage rejects review-vote-submit with non-string reviewId', async () => {
    const { callbacks, votes } = makeCallbacks();
    const p = makePanel(callbacks);
    const probe = p as unknown as HandleMessageProbe;
    await probe.handleMessage({
      type: 'review-vote-submit',
      reviewId: 42, // wrong type
      vote: 'approved',
    });
    assert.strictEqual(votes.length, 0);
  });

  test('handleMessage routes review-comment-submit to onCommentRequested', async () => {
    const { callbacks, comments } = makeCallbacks();
    const p = makePanel(callbacks);
    const probe = p as unknown as HandleMessageProbe;
    await probe.handleMessage({
      type: 'review-comment-submit',
      reviewId: 'r-1',
      filePath: 'src/foo.ts',
      line: 42,
      body: 'looks good',
    });
    assert.strictEqual(comments.length, 1);
    assert.deepStrictEqual(comments[0], {
      reviewId: 'r-1', filePath: 'src/foo.ts', line: 42, body: 'looks good',
    });
  });

  test('handleMessage rejects review-comment-submit with empty body', async () => {
    const { callbacks, comments } = makeCallbacks();
    const p = makePanel(callbacks);
    const probe = p as unknown as HandleMessageProbe;
    await probe.handleMessage({
      type: 'review-comment-submit',
      reviewId: 'r-1',
      filePath: 'src/foo.ts',
      line: 42,
      body: '',
    });
    assert.strictEqual(comments.length, 0);
  });

  test('handleMessage rejects review-comment-submit with body > 16 KiB', async () => {
    const { callbacks, comments } = makeCallbacks();
    const p = makePanel(callbacks);
    const probe = p as unknown as HandleMessageProbe;
    const huge = 'x'.repeat(16_385);
    await probe.handleMessage({
      type: 'review-comment-submit',
      reviewId: 'r-1',
      filePath: 'src/foo.ts',
      line: 42,
      body: huge,
    });
    assert.strictEqual(comments.length, 0,
      'comment > 16 KiB should be silently dropped (defense-in-depth)');
  });

  test('handleMessage rejects review-comment-submit with line < 1', async () => {
    const { callbacks, comments } = makeCallbacks();
    const p = makePanel(callbacks);
    const probe = p as unknown as HandleMessageProbe;
    await probe.handleMessage({
      type: 'review-comment-submit',
      reviewId: 'r-1',
      filePath: 'src/foo.ts',
      line: 0,
      body: 'hi',
    });
    assert.strictEqual(comments.length, 0);
  });

  test('handleMessage routes review-resolve-submit to onResolveRequested', async () => {
    const { callbacks, resolves } = makeCallbacks();
    const p = makePanel(callbacks);
    const probe = p as unknown as HandleMessageProbe;
    await probe.handleMessage({
      type: 'review-resolve-submit',
      reviewId: 'r-1',
      resolvedReason: 'merged',
    });
    assert.strictEqual(resolves.length, 1);
    assert.deepStrictEqual(resolves[0], { reviewId: 'r-1', resolvedReason: 'merged' });
  });

  test('handleMessage rejects review-resolve-submit with unknown resolvedReason', async () => {
    const { callbacks, resolves } = makeCallbacks();
    const p = makePanel(callbacks);
    const probe = p as unknown as HandleMessageProbe;
    await probe.handleMessage({
      type: 'review-resolve-submit',
      reviewId: 'r-1',
      resolvedReason: 'closed', // not in the allowed set
    });
    assert.strictEqual(resolves.length, 0);
  });

  test('handleMessage silently drops unknown message type (forward-compat)', async () => {
    const { callbacks, votes, comments, resolves } = makeCallbacks();
    const p = makePanel(callbacks);
    const probe = p as unknown as HandleMessageProbe;
    await probe.handleMessage({ type: 'future-action-not-yet-defined', payload: 'x' });
    assert.strictEqual(votes.length, 0);
    assert.strictEqual(comments.length, 0);
    assert.strictEqual(resolves.length, 0);
  });

  test('handleMessage silently drops null + non-object frames', async () => {
    const { callbacks, votes } = makeCallbacks();
    const p = makePanel(callbacks);
    const probe = p as unknown as HandleMessageProbe;
    await probe.handleMessage(null);
    await probe.handleMessage(undefined);
    await probe.handleMessage(42);
    await probe.handleMessage('string-frame');
    assert.strictEqual(votes.length, 0);
  });

  test('webview-ready frame is accepted (no-op, used for debug)', async () => {
    const { callbacks, votes, comments, resolves } = makeCallbacks();
    const p = makePanel(callbacks);
    const probe = p as unknown as HandleMessageProbe;
    // Should not throw and should not invoke any callback.
    await probe.handleMessage({ type: 'webview-ready' });
    assert.strictEqual(votes.length, 0);
    assert.strictEqual(comments.length, 0);
    assert.strictEqual(resolves.length, 0);
  });
});
