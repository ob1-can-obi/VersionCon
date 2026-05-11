import * as assert from 'assert';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import { WebSocket } from 'ws';

import { SessionHost } from '../../host/SessionHost.js';
import { ChatLog } from '../../filesystem/ChatLog.js';
import { AstAnalyzer } from '../../ast/AstAnalyzer.js';
import type {
  ProtocolMessage,
  ChatMessage,
  ChatMessageAmend,
  ChatHistory,
} from '../../network/protocol.js';
import type { HostIdentity, SessionConfig } from '../../types/session.js';
import type { PushRecord, PushFileEntry } from '../../types/push.js';

// -----------------------------------------------------------------------------
// Phase 5 Wave 5 (Plan 05-05) — END-TO-END integration test for the smart push
// summary. Exercises:
//   - real dist/ast-worker.js + real vendored WASMs (web-tree-sitter)
//   - real SessionHost (no analyzer stubs)
//   - two raw ws clients (host's pusher proxy + member B)
//   - real ChatLog persistence + chat-history replay
//
// Each test forks a worker process (the AstAnalyzer's child). First-grammar
// boot is ~100-500ms — mocha per-test timeout bumped to 20s. The
// astWorkerIntegration.test.ts suite covers the analyzer alone; this suite
// covers the wire flow + persistence + UI-trigger-path the analyzer feeds.
// -----------------------------------------------------------------------------

const WORKER_BUNDLE = path.resolve(process.cwd(), 'dist/ast-worker.js');
const INVITE = 'ABCDEFGH';
const HOST_NAME = 'HostUser';
const MAX_PAYLOAD = 1_000_000;

function makeHostIdentity(displayName: string = HOST_NAME): HostIdentity {
  return {
    memberId: crypto.randomUUID(),
    displayName,
    hostAuthSecret: crypto.randomUUID(),
  };
}

interface TestClient {
  ws: WebSocket;
  memberId: string;
  /** All received frames (buffered from open) so tests can inspect ordering. */
  receivedFrames: ProtocolMessage[];
  close(): Promise<void>;
}

async function connectClient(port: number, displayName: string): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const receivedFrames: ProtocolMessage[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as ProtocolMessage;
      receivedFrames.push(msg);
    } catch { /* ignore */ }
  });
  ws.send(JSON.stringify({
    type: 'auth-request',
    timestamp: Date.now(),
    inviteCode: INVITE,
    displayName,
  }));
  // Wait for auth-response synchronously by polling receivedFrames.
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const auth = receivedFrames.find(f => f.type === 'auth-response');
    if (auth) {
      if (auth.type === 'auth-response' && auth.accepted && auth.memberId) {
        return {
          ws,
          memberId: auth.memberId,
          receivedFrames,
          close: () => new Promise<void>((resolve) => {
            if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
            ws.once('close', () => resolve());
            ws.close();
          }),
        };
      }
      throw new Error('auth rejected');
    }
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('auth timeout');
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  pollMs = 25,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor predicate timeout');
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
}

// =============================================================================

suite('Phase 5 Wave 5 — AST broadcast integration (real worker + two hosts)', () => {
  // Per-test timeout bumped — real worker fork + WASM grammar boot can hit
  // ~500ms on first call.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (suite as any).timeout?.(20_000);

  let tmpDir: string;
  let branchDir: string;
  let host: SessionHost;
  let chatLog: ChatLog;
  let analyzer: AstAnalyzer | null = null;
  let port: number;

  suiteSetup(function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).timeout?.(20_000);
    assert.ok(
      fsSync.existsSync(WORKER_BUNDLE),
      `dist/ast-worker.js missing at ${WORKER_BUNDLE}. Run 'npm run build' first.`,
    );
  });

  setup(async function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).timeout?.(20_000);
    tmpDir = path.join(
      os.tmpdir(),
      `vc-broadcast-int-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    branchDir = path.join(tmpDir, 'branch');
    await fs.mkdir(branchDir, { recursive: true });
    chatLog = new ChatLog(branchDir);
    await chatLog.load();
    const config: SessionConfig = {
      sessionName: 'Phase5BroadcastInt',
      port: 0,
      networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD,
      inviteCode: INVITE,
    };
    host = new SessionHost(config, makeHostIdentity(HOST_NAME));
    host.setChatLog(chatLog, 'main');
    host.setBranchDirGetter(() => branchDir);
    analyzer = new AstAnalyzer(tmpDir, branchDir);
    host.setAstAnalyzer(analyzer);
    port = await host.start();
  });

  teardown(async () => {
    if (analyzer) {
      try { analyzer.dispose(); } catch { /* best-effort */ }
      analyzer = null;
    }
    try { host.stop(); } catch { /* best-effort */ }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makePushRecord(overrides: Partial<PushRecord> = {}): PushRecord {
    return {
      id: 'integ-push-1',
      memberId: 'pusher-not-tracked',
      memberDisplayName: HOST_NAME,
      message: 'integration test push',
      branch: 'main',
      files: [
        { relativePath: 'cart-helpers.js', status: 'modified', addedLines: 1, removedLines: 0 } as PushFileEntry,
      ],
      timestamp: Date.now(),
      reverted: false,
      ...overrides,
    };
  }

  // ---------- Test 1 — JS function attribution end-to-end ----------

  test('JS: cart-helpers.js calculateTotal renamed — Alice (cart.js refs) is in callers; amend frame matches recordId', async function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).timeout?.(20_000);

    // Seed the branch directory with Alice's tracked file so the host can
    // read it from the branch source-of-truth.
    // Files live at the branch root — pathMatches in joinImpact normalizes
    // imports against `changedIn`, and `./cart-helpers` only matches a flat
    // `cart-helpers.js` (not `src/cart-helpers.js`). Flat layout mirrors the
    // Wave 3 integration test's working setup.
    await fs.mkdir(branchDir, { recursive: true });
    const cartContent =
      `import { calculateTotal } from './cart-helpers';\n` +
      `\n` +
      `function main(items) {\n` +
      `  const t = calculateTotal(items);\n` +
      `  console.log(t);\n` +
      `}\n`;
    await fs.writeFile(path.join(branchDir, 'cart.js'), cartContent);

    const alice = await connectClient(port, 'Alice');
    host.setHostTrackedPaths(alice.memberId, ['cart.js']);

    // Pre/post for cart-helpers.js. v1 detects "modified" symbols by name +
    // line change — add a helper above so calculateTotal's line shifts.
    const pre = `function calculateTotal(items) {\n  return 0;\n}\n`;
    const post =
      `function priceOf(item) {\n  return item.price;\n}\n` +
      `\n` +
      `function calculateTotal(items) {\n  let s = 0;\n  for (const i of items) s += priceOf(i);\n  return s;\n}\n`;
    const prePostMap = new Map([
      ['cart-helpers.js', { preContent: pre, postContent: post }],
    ]);
    const record = makePushRecord({ memberId: 'pusher-not-tracked' });

    // Sync path: broadcastPush returns immediately; the amend lands async.
    const systemRecord = host.broadcastPush(record, prePostMap);

    // Wait up to 15s for the amend (worker boot + WASM init).
    await waitFor(
      () => alice.receivedFrames.some(f => f.type === 'chat-message-amend'),
      15_000,
    );

    const chatFrame = alice.receivedFrames.find(f => f.type === 'chat-message') as ChatMessage | undefined;
    const amendFrame = alice.receivedFrames.find(f => f.type === 'chat-message-amend') as ChatMessageAmend | undefined;
    assert.ok(chatFrame, 'chat-message wire frame received');
    assert.ok(amendFrame, 'chat-message-amend wire frame received');

    // Wire ordering: amend AFTER chat-message.
    const chatIdx = alice.receivedFrames.indexOf(chatFrame);
    const amendIdx = alice.receivedFrames.indexOf(amendFrame);
    assert.ok(amendIdx > chatIdx, 'amend received AFTER chat-message');

    // recordIds match — clients can locate the original record by id.
    assert.strictEqual(amendFrame.recordId, chatFrame.recordId);
    assert.strictEqual(amendFrame.recordId, systemRecord.id);

    // SC-1 attribution: calculateTotal in affectedSymbols + Alice in callers.
    const ct = amendFrame.affectedSymbols.find(s => s.name === 'calculateTotal');
    assert.ok(ct, 'calculateTotal in affectedSymbols');
    assert.strictEqual(ct.changedIn, 'cart-helpers.js');
    const aliceCaller = ct.callers.find(c => c.memberId === alice.memberId);
    assert.ok(aliceCaller, 'Alice in calculateTotal callers');
    assert.strictEqual(aliceCaller.file, 'cart.js');

    await alice.close();
  });

  // ---------- Test 2 — unsupported language fallback path (SC-3) ----------

  test('unsupported language (.kt): unsupportedLanguages populated, amend fires', async function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).timeout?.(20_000);

    // Deviation note (vs Plan 05-05 wording): the plan called this the "Java
    // case" expecting unsupportedLanguages:['java']. The actual Wave 3
    // implementation registers Java in AstFactory routed through the
    // FallbackAdapter, so Java does NOT land in unsupportedLanguages — it
    // emits file-level pseudo-symbols instead. To verify the SC-3
    // "unsupportedLanguages signal fires" contract we use Kotlin (.kt) which
    // is NOT in EXT_MAP — detectLanguageFromPath returns null and the
    // worker emits 'unknown' into unsupportedLanguages. The amend MUST still
    // fire so a client can render the SC-3 fallback tooltip (the plan's
    // user-visible contract is preserved; only the language label name
    // shifts).
    await fs.mkdir(branchDir, { recursive: true });
    await fs.writeFile(
      path.join(branchDir, 'Main.kt'),
      `fun main() { Service.compute() }\n`,
    );

    const alice = await connectClient(port, 'Alice');
    host.setHostTrackedPaths(alice.memberId, ['Main.kt']);

    const pre = `class Service { fun compute() = 0 }\n`;
    const post = `// edit\nclass Service { fun compute() = 42 }\n`;
    const prePostMap = new Map([
      ['Service.kt', { preContent: pre, postContent: post }],
    ]);
    const record = makePushRecord({
      memberId: 'pusher-not-tracked',
      files: [{ relativePath: 'Service.kt', status: 'modified', addedLines: 1, removedLines: 0 } as PushFileEntry],
    });

    host.broadcastPush(record, prePostMap);

    await waitFor(
      () => alice.receivedFrames.some(f => f.type === 'chat-message-amend'),
      15_000,
    );
    const amend = alice.receivedFrames.find(f => f.type === 'chat-message-amend') as ChatMessageAmend;
    // Contract: SC-3 signal fires (length > 0). Exact label is
    // implementation-defined ('unknown' in v1 for paths with no language).
    assert.ok(
      amend.unsupportedLanguages.length > 0,
      'unsupportedLanguages populated',
    );

    await alice.close();
  });

  // ---------- Test 3 — no-impact green path ----------

  test('no-impact: changed file no member tracks — NO amend (empty-result short-circuit)', async function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).timeout?.(20_000);

    const alice = await connectClient(port, 'Alice');
    // Alice tracks an unrelated file — no overlap with the push.
    // Files live at the branch root — pathMatches in joinImpact normalizes
    // imports against `changedIn`, and `./cart-helpers` only matches a flat
    // `cart-helpers.js` (not `src/cart-helpers.js`). Flat layout mirrors the
    // Wave 3 integration test's working setup.
    await fs.mkdir(branchDir, { recursive: true });
    await fs.writeFile(path.join(branchDir, 'unrelated.js'), 'const x = 1;\n');
    host.setHostTrackedPaths(alice.memberId, ['unrelated.js']);

    const pre = `function alone() { return 0; }\n`;
    const post = `// header\nfunction alone() { return 1; }\n`;
    const prePostMap = new Map([
      ['alone.js', { preContent: pre, postContent: post }],
    ]);
    const record = makePushRecord({
      memberId: 'pusher-not-tracked',
      files: [{ relativePath: 'alone.js', status: 'modified', addedLines: 1, removedLines: 0 } as PushFileEntry],
    });

    host.broadcastPush(record, prePostMap);

    // Wait for chat-message to land + extra time for any amend to NOT fire.
    await waitFor(
      () => alice.receivedFrames.some(f => f.type === 'chat-message'),
      5000,
    );
    // Give the worker time to complete; it must NOT broadcast an amend.
    await new Promise(r => setTimeout(r, 3000));
    const amend = alice.receivedFrames.find(f => f.type === 'chat-message-amend');
    assert.strictEqual(amend, undefined, 'no amend for a no-impact push');

    await alice.close();
  });

  // ---------- Test 4 — late-joiner replay carries the amend ----------

  test('late-joiner: Bob joins AFTER amend — chat-history replay carries the patched meta', async function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).timeout?.(20_000);

    // Alice triggers the push that produces an amend.
    // Files live at the branch root — pathMatches in joinImpact normalizes
    // imports against `changedIn`, and `./cart-helpers` only matches a flat
    // `cart-helpers.js` (not `src/cart-helpers.js`). Flat layout mirrors the
    // Wave 3 integration test's working setup.
    await fs.mkdir(branchDir, { recursive: true });
    await fs.writeFile(
      path.join(branchDir, 'cart.js'),
      `import { calculateTotal } from './cart-helpers';\nfunction main(items) {\n  return calculateTotal(items);\n}\n`,
    );
    const alice = await connectClient(port, 'Alice');
    host.setHostTrackedPaths(alice.memberId, ['cart.js']);

    const pre = `function calculateTotal(items) { return 0; }\n`;
    const post = `// header\nfunction calculateTotal(items) { return 1; }\n`;
    const prePostMap = new Map([
      ['cart-helpers.js', { preContent: pre, postContent: post }],
    ]);
    host.broadcastPush(makePushRecord({ memberId: 'pusher-not-tracked' }), prePostMap);

    // Wait until alice gets the amend — guarantees chat-log patchMeta has run.
    await waitFor(
      () => alice.receivedFrames.some(f => f.type === 'chat-message-amend'),
      15_000,
    );

    // Bob joins now — chat-history replay must carry the amended meta.
    const bob = await connectClient(port, 'Bob');
    await waitFor(
      () => bob.receivedFrames.some(f => f.type === 'chat-history'),
      3000,
    );
    const history = bob.receivedFrames.find(f => f.type === 'chat-history') as ChatHistory;
    const pushSysRecord = history.records.find(r => r.subKind === 'push');
    assert.ok(pushSysRecord, 'push system event in history');
    assert.ok(pushSysRecord.meta?.affectedSymbols, 'amended meta carried in replay');
    assert.ok(pushSysRecord.meta!.affectedSymbols!.length >= 1, 'at least one affected symbol in replayed meta');

    await alice.close();
    await bob.close();
  });

  // ---------- Test 5 — mixed JS + unsupported language in one push ----------

  test('mixed: one JS + one unsupported (.kt) in same push — JS attributes; unsupportedLanguages populated', async function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).timeout?.(20_000);

    // See Test 2 for the Java-vs-Kotlin deviation rationale.
    await fs.mkdir(branchDir, { recursive: true });
    await fs.writeFile(
      path.join(branchDir, 'cart.js'),
      `import { calculateTotal } from './cart-helpers';\nfunction main(items) { return calculateTotal(items); }\n`,
    );

    const alice = await connectClient(port, 'Alice');
    host.setHostTrackedPaths(alice.memberId, ['cart.js']);

    const jsPre = `function calculateTotal(items) { return 0; }\n`;
    const jsPost = `// header\nfunction calculateTotal(items) { return 1; }\n`;
    const ktPre = `class Foo {}\n`;
    const ktPost = `// edit\nclass Foo {}\n`;
    const prePostMap = new Map([
      ['cart-helpers.js', { preContent: jsPre, postContent: jsPost }],
      ['Foo.kt', { preContent: ktPre, postContent: ktPost }],
    ]);
    host.broadcastPush(
      makePushRecord({
        memberId: 'pusher-not-tracked',
        files: [
          { relativePath: 'cart-helpers.js', status: 'modified', addedLines: 1, removedLines: 0 } as PushFileEntry,
          { relativePath: 'Foo.kt', status: 'modified', addedLines: 1, removedLines: 0 } as PushFileEntry,
        ],
      }),
      prePostMap,
    );

    await waitFor(
      () => alice.receivedFrames.some(f => f.type === 'chat-message-amend'),
      15_000,
    );
    const amend = alice.receivedFrames.find(f => f.type === 'chat-message-amend') as ChatMessageAmend;
    assert.ok(amend.affectedSymbols.some(s => s.name === 'calculateTotal'), 'JS calculateTotal attributed');
    assert.ok(amend.unsupportedLanguages.length > 0, 'unsupportedLanguages populated by .kt');

    await alice.close();
  });

  // ---------- Test 6 — pusher excluded from analyzer payload ----------

  test('pusher excluded: when alice is the pusher, the analyzer does not list her among trackees', async function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).timeout?.(20_000);

    // Files live at the branch root — pathMatches in joinImpact normalizes
    // imports against `changedIn`, and `./cart-helpers` only matches a flat
    // `cart-helpers.js` (not `src/cart-helpers.js`). Flat layout mirrors the
    // Wave 3 integration test's working setup.
    await fs.mkdir(branchDir, { recursive: true });
    await fs.writeFile(
      path.join(branchDir, 'cart.js'),
      `import { calculateTotal } from './cart-helpers';\nfunction main(items) { return calculateTotal(items); }\n`,
    );
    await fs.writeFile(
      path.join(branchDir, 'other.js'),
      `import { calculateTotal } from './cart-helpers';\nfunction lib() { return calculateTotal([]); }\n`,
    );

    const alice = await connectClient(port, 'Alice');
    const bob = await connectClient(port, 'Bob');
    host.setHostTrackedPaths(alice.memberId, ['cart.js']);
    host.setHostTrackedPaths(bob.memberId, ['other.js']);

    const pre = `function calculateTotal(items) { return 0; }\n`;
    const post = `// header\nfunction calculateTotal(items) { return 1; }\n`;
    const prePostMap = new Map([
      ['cart-helpers.js', { preContent: pre, postContent: post }],
    ]);
    // Alice is the pusher.
    host.broadcastPush(
      makePushRecord({ memberId: alice.memberId }),
      prePostMap,
    );

    // Wait for bob to receive the amend.
    await waitFor(
      () => bob.receivedFrames.some(f => f.type === 'chat-message-amend'),
      15_000,
    );
    const amend = bob.receivedFrames.find(f => f.type === 'chat-message-amend') as ChatMessageAmend;
    const ct = amend.affectedSymbols.find(s => s.name === 'calculateTotal');
    assert.ok(ct, 'calculateTotal in affectedSymbols');
    // Alice (the pusher) MUST NOT appear in the callers list — host excluded her.
    const aliceInCallers = ct.callers.find(c => c.memberId === alice.memberId);
    assert.strictEqual(aliceInCallers, undefined, 'pusher (Alice) not in callers');
    // Bob is in callers (he tracks src/other.js which imports calculateTotal).
    const bobInCallers = ct.callers.find(c => c.memberId === bob.memberId);
    assert.ok(bobInCallers, 'Bob (non-pusher) is in callers');

    await alice.close();
    await bob.close();
  });

  // ---------- Test 7 — SC-2 timing under real worker ----------

  test('SC-2 timing: broadcastPush returns <100ms even when a real worker is wired', async function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).timeout?.(20_000);

    // Real worker fork is heavyweight on FIRST call (~500ms WASM init).
    // SC-2 invariant is that the SYNC PATH is unblocked — the analyzer fire
    // is fire-and-forget. We use a 100ms ceiling on the sync path (vs the
    // 50ms stub-based threshold) since the broadcast involves real ws send
    // calls + chat-log append. Anything > 200ms is a real regression.

    // Files live at the branch root — pathMatches in joinImpact normalizes
    // imports against `changedIn`, and `./cart-helpers` only matches a flat
    // `cart-helpers.js` (not `src/cart-helpers.js`). Flat layout mirrors the
    // Wave 3 integration test's working setup.
    await fs.mkdir(branchDir, { recursive: true });
    await fs.writeFile(
      path.join(branchDir, 'cart.js'),
      `import { calculateTotal } from './cart-helpers';\nfunction main() {}\n`,
    );
    const alice = await connectClient(port, 'Alice');
    host.setHostTrackedPaths(alice.memberId, ['cart.js']);

    const pre = `function calculateTotal(items) { return 0; }\n`;
    const post = `// header\nfunction calculateTotal(items) { return 1; }\n`;
    const prePostMap = new Map([
      ['cart-helpers.js', { preContent: pre, postContent: post }],
    ]);

    const start = Date.now();
    host.broadcastPush(makePushRecord({ memberId: 'pusher-not-tracked' }), prePostMap);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 100, `broadcastPush sync path should complete <100ms; got ${elapsed}ms`);

    await alice.close();
  });
});
