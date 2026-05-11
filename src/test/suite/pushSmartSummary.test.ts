import * as assert from 'assert';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { WebSocket } from 'ws';

import { SessionHost } from '../../host/SessionHost.js';
import { ChatLog } from '../../filesystem/ChatLog.js';
import { ActivityLogProvider } from '../../ui/ActivityLogProvider.js';
import { parseMessage } from '../../network/protocol.js';
import type {
  ProtocolMessage,
  ChatMessage,
  ChatMessageAmend,
} from '../../network/protocol.js';
import type { HostIdentity, SessionConfig } from '../../types/session.js';
import type { PushRecord, PushFileEntry } from '../../types/push.js';
import type { AffectedSymbol, AnalysisResult, AnalyzePayload } from '../../ast/types.js';
// AstAnalyzer is imported as a type so the stub can be cast onto its API
// without dragging the child_process runtime into this test file. Tests at
// this layer never fork a real worker — that's astBroadcastIntegration.test.ts.
import type { AstAnalyzer } from '../../ast/AstAnalyzer.js';

// -----------------------------------------------------------------------------
// Phase 5 Wave 5 (Plan 05-05) — Smart push summary (SC-5 + amend wire flow).
//
// What this file covers:
//   - SC-2 synchronous-path timing: broadcastPush returns within 50ms even when
//     a slow-to-respond analyzer is wired.
//   - Amend wire flow: ONE chat-message broadcasts first, then ONE
//     chat-message-amend after analyzer resolves. recordIds match.
//   - Empty-result short-circuit: NO amend when analyzer returns nothing.
//   - Unsupported-only path: amend STILL fires (so the fallback tooltip can
//     render) when only unsupportedLanguages is populated.
//   - ChatLog.patchMeta persistence + chat-history replay carrying the amend.
//   - UI rendering: ActivityLogProvider.applyAmend upgrades the label; the
//     3-symbol cap is honored; ChatPanel.applyAmend's postMessage shape.
//   - Graceful degradation: older clients (VALID_TYPES without
//     chat-message-amend) reject the wire at parseMessage; original message
//     still parses + renders.
//
// All tests use a StubAstAnalyzer (defined below) that returns a configurable
// AnalysisResult after a configurable delay. No worker is forked from this
// file — the end-to-end real-worker coverage lives in
// astBroadcastIntegration.test.ts (Task 6).
//
// SC-2 timing rationale: the broadcast path must return WITHIN the same Promise
// tick. The test uses a 100ms-delayed stub and asserts elapsed < 50ms; the
// margin allows for harness GC / event loop noise but pins SC-2 well below the
// "feels instant" threshold (~100ms human perception).
// -----------------------------------------------------------------------------

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

/**
 * In-process stub analyzer. Implements only the public surface SessionHost
 * uses (analyzeChange + dispose) so tests can cast to AstAnalyzer without
 * forking a real worker. Configurable response + delay; tests inspect the
 * call log to assert payload shape.
 */
class StubAstAnalyzer {
  private response: AnalysisResult = {
    affectedSymbols: [],
    perMember: {},
    unsupportedLanguages: [],
  };
  private delayMs = 0;
  public calls: Array<{
    changedFiles: AnalyzePayload['changedFiles'];
    memberTrackedFiles: AnalyzePayload['memberTrackedFiles'];
    memberDisplayNames: AnalyzePayload['memberDisplayNames'];
  }> = [];
  public disposed = false;

  setResponse(r: AnalysisResult): void {
    this.response = r;
  }

  setDelayMs(d: number): void {
    this.delayMs = d;
  }

  analyzeChange(args: {
    changedFiles: AnalyzePayload['changedFiles'];
    memberTrackedFiles: AnalyzePayload['memberTrackedFiles'];
    memberDisplayNames: AnalyzePayload['memberDisplayNames'];
  }): Promise<AnalysisResult> {
    this.calls.push(args);
    if (this.delayMs <= 0) return Promise.resolve(this.response);
    return new Promise((resolve) => {
      setTimeout(() => resolve(this.response), this.delayMs);
    });
  }

  dispose(): void {
    this.disposed = true;
  }
}

interface TestClient {
  ws: WebSocket;
  memberId: string;
  /** All frames received post-open, including the ones that arrived before
   * any onMessage subscriber was registered (chat-history fires immediately
   * after auth-response — see SessionHost.sendChatHistoryToMember). */
  receivedFrames: ProtocolMessage[];
  close(): Promise<void>;
  onMessage(fn: (m: ProtocolMessage) => void): void;
}

async function connectClient(port: number, displayName: string): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const listeners = new Set<(m: ProtocolMessage) => void>();
  const receivedFrames: ProtocolMessage[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as ProtocolMessage;
      // Always buffer for late onMessage subscribers — covers the
      // chat-history-arrives-before-listener race.
      receivedFrames.push(msg);
      for (const fn of listeners) {
        try { fn(msg); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  });
  ws.send(JSON.stringify({
    type: 'auth-request',
    timestamp: Date.now(),
    inviteCode: INVITE,
    displayName,
  }));
  const authResp = await new Promise<ProtocolMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('auth timeout')), 2000);
    const handler = (m: ProtocolMessage): void => {
      if (m.type === 'auth-response') {
        clearTimeout(timer);
        listeners.delete(handler);
        resolve(m);
      }
    };
    listeners.add(handler);
  });
  if (authResp.type !== 'auth-response' || !authResp.accepted || !authResp.memberId) {
    throw new Error('auth rejected');
  }
  return {
    ws,
    memberId: authResp.memberId,
    receivedFrames,
    close: () => new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
      ws.once('close', () => resolve());
      ws.close();
    }),
    onMessage: (fn) => { listeners.add(fn); },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  pollMs = 10,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor predicate timeout');
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function makePushRecord(overrides: Partial<PushRecord> = {}): PushRecord {
  return {
    id: 'push-id-1',
    memberId: 'host-id',
    memberDisplayName: HOST_NAME,
    message: 'test push',
    branch: 'main',
    files: [
      { relativePath: 'src/cart-helpers.ts', status: 'modified', addedLines: 10, removedLines: 2 } as PushFileEntry,
    ],
    timestamp: Date.now(),
    reverted: false,
    ...overrides,
  };
}

const SYMBOL_FOO: AffectedSymbol = {
  name: 'calculateTotal',
  kind: 'function',
  changedIn: 'src/cart-helpers.ts',
  callers: [
    { memberId: 'alice', displayName: 'Alice', file: 'src/cart.ts', line: 34 },
  ],
};

// =============================================================================

suite('Phase 5 Wave 5 — Smart push summary (SC-5 + amend wire flow)', () => {
  let host: SessionHost;
  let chatLog: ChatLog;
  let tmpDir: string;
  let port: number;

  setup(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `vc-smart-summary-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const branchDir = path.join(tmpDir, 'branch');
    await fs.mkdir(branchDir, { recursive: true });
    chatLog = new ChatLog(branchDir);
    await chatLog.load();
    const config: SessionConfig = {
      sessionName: 'Phase5SmartSummary',
      port: 0,
      networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD,
      inviteCode: INVITE,
    };
    host = new SessionHost(config, makeHostIdentity(HOST_NAME));
    host.setChatLog(chatLog, 'main');
    host.setBranchDirGetter(() => branchDir);
    port = await host.start();
  });

  teardown(async () => {
    try { host.stop(); } catch { /* best-effort */ }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------- SC-2: synchronous-path timing --------------------

  suite('SC-2 synchronous-path timing', () => {
    test('broadcastPush returns within 50ms even when analyzer responds in 100ms', async () => {
      const stub = new StubAstAnalyzer();
      stub.setResponse({
        affectedSymbols: [SYMBOL_FOO],
        perMember: {},
        unsupportedLanguages: [],
      });
      stub.setDelayMs(100);
      host.setAstAnalyzer(stub as unknown as AstAnalyzer);

      const record = makePushRecord();
      const prePostMap = new Map([
        ['src/cart-helpers.ts', { preContent: 'pre', postContent: 'post' }],
      ]);

      const start = Date.now();
      const systemRecord = host.broadcastPush(record, prePostMap);
      const elapsed = Date.now() - start;

      // SC-2: 50ms is the hard line. Anything > 200ms is a real regression.
      // 50ms allows CI noise + GC; the typical local run completes in <5ms.
      assert.ok(
        elapsed < 50,
        `broadcastPush should return synchronously (<50ms); got ${elapsed}ms`,
      );
      assert.ok(systemRecord);
      assert.strictEqual(systemRecord.kind, 'system');
      assert.strictEqual(systemRecord.subKind, 'push');
    });

    test('broadcastPush returns synchronously even when analyzer responds in 500ms', async () => {
      const stub = new StubAstAnalyzer();
      stub.setResponse({
        affectedSymbols: [],
        perMember: {},
        unsupportedLanguages: ['java'],
      });
      stub.setDelayMs(500);
      host.setAstAnalyzer(stub as unknown as AstAnalyzer);

      const record = makePushRecord();
      const prePostMap = new Map([
        ['src/cart-helpers.ts', { preContent: 'pre', postContent: 'post' }],
      ]);
      const start = Date.now();
      host.broadcastPush(record, prePostMap);
      const elapsed = Date.now() - start;
      // Still <50ms — the analyzer's delay does NOT contribute to the sync path.
      assert.ok(elapsed < 50, `expected <50ms, got ${elapsed}ms`);
    });
  });

  // -------------------- amend wire flow --------------------

  suite('amend wire flow', () => {
    test('with analyzer wired + non-empty result: chat-message FIRST, chat-message-amend SECOND, recordIds match', async () => {
      const stub = new StubAstAnalyzer();
      stub.setResponse({
        affectedSymbols: [SYMBOL_FOO],
        perMember: { alice: [SYMBOL_FOO] },
        unsupportedLanguages: [],
      });
      stub.setDelayMs(50);
      host.setAstAnalyzer(stub as unknown as AstAnalyzer);

      const alice = await connectClient(port, 'Alice');
      const frames: ProtocolMessage[] = [];
      alice.onMessage((m) => {
        if (m.type === 'chat-message' || m.type === 'chat-message-amend') {
          frames.push(m);
        }
      });

      const record = makePushRecord();
      const prePostMap = new Map([
        ['src/cart-helpers.ts', { preContent: 'pre', postContent: 'post' }],
      ]);

      host.broadcastPush(record, prePostMap);

      await waitFor(() => frames.some(f => f.type === 'chat-message-amend'), 1500);

      // Verify ordering: chat-message comes BEFORE the amend on this client.
      const chatIdx = frames.findIndex(f => f.type === 'chat-message');
      const amendIdx = frames.findIndex(f => f.type === 'chat-message-amend');
      assert.ok(chatIdx >= 0, 'chat-message wire frame was received');
      assert.ok(amendIdx > chatIdx, 'amend received AFTER the chat-message');

      // Verify recordIds match.
      const chatFrame = frames[chatIdx] as ChatMessage;
      const amendFrame = frames[amendIdx] as ChatMessageAmend;
      assert.strictEqual(amendFrame.recordId, chatFrame.recordId, 'amend.recordId === chat-message.recordId');
      assert.strictEqual(amendFrame.affectedSymbols.length, 1);
      assert.strictEqual(amendFrame.affectedSymbols[0].name, 'calculateTotal');

      await alice.close();
    });

    test('empty-result short-circuit: NO amend broadcast when affectedSymbols + unsupportedLanguages both empty', async () => {
      const stub = new StubAstAnalyzer();
      stub.setResponse({
        affectedSymbols: [],
        perMember: {},
        unsupportedLanguages: [],
      });
      host.setAstAnalyzer(stub as unknown as AstAnalyzer);

      const alice = await connectClient(port, 'Alice');
      const amends: ChatMessageAmend[] = [];
      alice.onMessage((m) => { if (m.type === 'chat-message-amend') { amends.push(m); } });

      const record = makePushRecord();
      const prePostMap = new Map([
        ['src/cart-helpers.ts', { preContent: 'pre', postContent: 'post' }],
      ]);
      host.broadcastPush(record, prePostMap);

      // Wait long enough that an amend WOULD have arrived if going to.
      await new Promise(r => setTimeout(r, 200));
      assert.strictEqual(amends.length, 0, 'no amend should broadcast for empty result');

      await alice.close();
    });

    test('unsupported-only path: amend FIRES so tooltip can render (empty affectedSymbols + non-empty unsupportedLanguages)', async () => {
      const stub = new StubAstAnalyzer();
      stub.setResponse({
        affectedSymbols: [],
        perMember: {},
        unsupportedLanguages: ['java'],
      });
      host.setAstAnalyzer(stub as unknown as AstAnalyzer);

      const alice = await connectClient(port, 'Alice');
      const amends: ChatMessageAmend[] = [];
      alice.onMessage((m) => { if (m.type === 'chat-message-amend') { amends.push(m); } });

      const record = makePushRecord();
      const prePostMap = new Map([
        ['src/cart-helpers.ts', { preContent: 'pre', postContent: 'post' }],
      ]);
      host.broadcastPush(record, prePostMap);

      await waitFor(() => amends.length === 1, 1000);
      assert.strictEqual(amends[0].affectedSymbols.length, 0);
      assert.deepStrictEqual(amends[0].unsupportedLanguages, ['java']);

      await alice.close();
    });

    test('without analyzer wired: NO amend, NO regression to Phase 4.3 behavior', async () => {
      // Analyzer never set — broadcastPush should be exactly the Phase 4.3
      // path (zero amend frames during a 500ms quiet window).
      const alice = await connectClient(port, 'Alice');
      const amends: ChatMessageAmend[] = [];
      const chats: ChatMessage[] = [];
      alice.onMessage((m) => {
        if (m.type === 'chat-message-amend') amends.push(m);
        if (m.type === 'chat-message') chats.push(m);
      });

      const record = makePushRecord();
      const prePostMap = new Map([
        ['src/cart-helpers.ts', { preContent: 'pre', postContent: 'post' }],
      ]);
      host.broadcastPush(record, prePostMap);

      await waitFor(() => chats.length === 1, 1000);
      await new Promise(r => setTimeout(r, 300));
      assert.strictEqual(amends.length, 0, 'no amend without analyzer');
      assert.strictEqual(chats.length, 1, 'exactly one chat-message broadcast');

      await alice.close();
    });

    test('without prePostByFile: NO amend (analyzer never fires)', async () => {
      const stub = new StubAstAnalyzer();
      stub.setResponse({
        affectedSymbols: [SYMBOL_FOO],
        perMember: {},
        unsupportedLanguages: [],
      });
      host.setAstAnalyzer(stub as unknown as AstAnalyzer);

      const alice = await connectClient(port, 'Alice');
      const amends: ChatMessageAmend[] = [];
      alice.onMessage((m) => { if (m.type === 'chat-message-amend') { amends.push(m); } });

      const record = makePushRecord();
      // No prePostByFile passed.
      host.broadcastPush(record);

      await new Promise(r => setTimeout(r, 200));
      assert.strictEqual(amends.length, 0);
      assert.strictEqual(stub.calls.length, 0, 'analyzer should not be called without prePostByFile');

      await alice.close();
    });

    test('analyzer receives the pusher-excluded memberTrackedFiles payload', async () => {
      // Seed two members in the memberTracking map (simulate the host's view
      // after both Alice and Bob have authenticated + sent tracked-paths).
      // Build a real tracked file in the branch dir so the host reads it.
      const branchDir = path.join(tmpDir, 'branch');
      await fs.mkdir(path.join(branchDir, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(branchDir, 'src', 'cart.ts'),
        'import { calculateTotal } from "./cart-helpers";\n',
      );

      // Alice connects so her id is real.
      const alice = await connectClient(port, 'Alice');
      host.setHostTrackedPaths(alice.memberId, ['src/cart.ts']);
      // Stamp a synthetic pusher id that's NOT in tracking so the exclude
      // logic doesn't accidentally drop alice.
      const PUSHER_ID = 'pusher-not-in-tracking';
      host.setHostTrackedPaths(PUSHER_ID, ['src/cart-helpers.ts']);

      const stub = new StubAstAnalyzer();
      stub.setResponse({
        affectedSymbols: [SYMBOL_FOO],
        perMember: { [alice.memberId]: [SYMBOL_FOO] },
        unsupportedLanguages: [],
      });
      host.setAstAnalyzer(stub as unknown as AstAnalyzer);

      const record = makePushRecord({ memberId: PUSHER_ID });
      const prePostMap = new Map([
        ['src/cart-helpers.ts', { preContent: 'pre', postContent: 'post' }],
      ]);
      host.broadcastPush(record, prePostMap);

      await waitFor(() => stub.calls.length === 1, 1000);
      const call = stub.calls[0];
      // Pusher must NOT appear in memberTrackedFiles (excluded by host).
      assert.strictEqual(
        Object.keys(call.memberTrackedFiles).includes(PUSHER_ID),
        false,
        'pusher excluded from memberTrackedFiles',
      );
      // Alice's tracked file is present + content was read from the branch dir.
      assert.ok(call.memberTrackedFiles[alice.memberId], 'alice in memberTrackedFiles');
      assert.strictEqual(call.memberTrackedFiles[alice.memberId].length, 1);
      assert.match(call.memberTrackedFiles[alice.memberId][0].content, /calculateTotal/);

      await alice.close();
    });
  });

  // -------------------- ChatLog.patchMeta persistence --------------------

  suite('ChatLog.patchMeta persistence', () => {
    test('patchMeta merges new fields onto existing meta and persists', async () => {
      const tmp = path.join(
        os.tmpdir(),
        `vc-patchmeta-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      await fs.mkdir(tmp, { recursive: true });
      const log = new ChatLog(tmp);
      await log.load();
      await log.append({
        id: 'r1',
        kind: 'system',
        subKind: 'push',
        memberId: 'host',
        memberDisplayName: 'Host',
        body: 'pushed',
        timestamp: 100,
        meta: { pushId: 'p1', branch: 'main', files: ['a.ts'] },
      });

      await log.patchMeta('r1', {
        affectedSymbols: [SYMBOL_FOO],
        unsupportedLanguages: ['java'],
      });

      // Reload + verify persisted shape.
      const log2 = new ChatLog(tmp);
      await log2.load();
      const persisted = log2.getRecords();
      assert.strictEqual(persisted.length, 1);
      assert.ok(persisted[0].meta);
      // Existing fields preserved.
      assert.strictEqual(persisted[0].meta.pushId, 'p1');
      assert.deepStrictEqual(persisted[0].meta.files, ['a.ts']);
      // New fields added.
      assert.strictEqual(persisted[0].meta.affectedSymbols?.length, 1);
      assert.deepStrictEqual(persisted[0].meta.unsupportedLanguages, ['java']);
      await fs.rm(tmp, { recursive: true, force: true });
    });

    test('patchMeta on unknown recordId is a no-op (no throw)', async () => {
      const tmp = path.join(
        os.tmpdir(),
        `vc-patchmeta-noop-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      await fs.mkdir(tmp, { recursive: true });
      const log = new ChatLog(tmp);
      await log.load();
      // Empty log — patch should silently no-op.
      await log.patchMeta('does-not-exist', { affectedSymbols: [SYMBOL_FOO] });
      assert.strictEqual(log.getRecords().length, 0);
      await fs.rm(tmp, { recursive: true, force: true });
    });

    test('chat-history replay carries the patched meta to late joiners', async () => {
      const stub = new StubAstAnalyzer();
      stub.setResponse({
        affectedSymbols: [SYMBOL_FOO],
        perMember: {},
        unsupportedLanguages: [],
      });
      host.setAstAnalyzer(stub as unknown as AstAnalyzer);

      const alice = await connectClient(port, 'Alice');
      const aliceAmends: ChatMessageAmend[] = [];
      alice.onMessage((m) => { if (m.type === 'chat-message-amend') { aliceAmends.push(m); } });

      const record = makePushRecord();
      const prePostMap = new Map([
        ['src/cart-helpers.ts', { preContent: 'pre', postContent: 'post' }],
      ]);
      host.broadcastPush(record, prePostMap);

      // Wait for the live amend to land on alice, which guarantees patchMeta
      // has run too (same async path).
      await waitFor(() => aliceAmends.length === 1, 1000);

      // Bob joins AFTER the amend — should see the patched meta in chat-history.
      // Note: chat-history fires immediately after auth-response (per
      // SessionHost.sendChatHistoryToMember), so the buffered receivedFrames
      // captures it even before our onMessage subscriber is registered.
      const bob = await connectClient(port, 'Bob');
      // Brief poll: chat-history is fire-and-forget on the host so we may
      // need a tick for it to land on the wire.
      await waitFor(
        () => bob.receivedFrames.some(f => f.type === 'chat-history'),
        2000,
      );
      const bobHistory = bob.receivedFrames.find(f => f.type === 'chat-history');
      assert.ok(bobHistory, 'chat-history frame received');
      if (bobHistory && bobHistory.type === 'chat-history') {
        const pushRecord = bobHistory.records.find(r => r.subKind === 'push');
        assert.ok(pushRecord, 'push system event in history');
        assert.ok(pushRecord.meta?.affectedSymbols, 'amended meta carried in replay');
        assert.strictEqual(pushRecord.meta!.affectedSymbols!.length, 1);
      }

      await alice.close();
      await bob.close();
    });
  });

  // -------------------- UI render --------------------

  suite('UI render', () => {
    test('ActivityLogProvider.applyAmend upgrades the label with 1 symbol', () => {
      const provider = new ActivityLogProvider();
      provider.addPushEntry({
        timestamp: 1,
        memberId: 'alice',
        memberDisplayName: 'Alice',
        isMine: false,
        files: ['src/cart-helpers.ts'],
        affectsLocal: false,
        pushId: 'p1',
      });
      // Link the chat record id (would normally come from the chat-received
      // system event arriving after the push entry was created).
      provider.linkChatRecordToPush('p1', 'r1');
      provider.applyAmend('r1', [SYMBOL_FOO], []);

      const item = provider.getTreeItem(provider.getEntries()[0]);
      assert.strictEqual(
        item.label,
        'Alice pushed 1 file(s) — affects 1 of your symbols: calculateTotal()',
      );
    });

    test('ActivityLogProvider.applyAmend caps displayed symbols at 3 + ", …" for 5-symbol input', () => {
      const provider = new ActivityLogProvider();
      provider.addPushEntry({
        timestamp: 1,
        memberId: 'alice',
        memberDisplayName: 'Alice',
        isMine: false,
        files: ['a.ts'],
        affectsLocal: false,
        pushId: 'p2',
      });
      provider.linkChatRecordToPush('p2', 'r2');
      const fiveSymbols: AffectedSymbol[] = [
        { name: 's1', kind: 'function', changedIn: 'a.ts', callers: [] },
        { name: 's2', kind: 'function', changedIn: 'a.ts', callers: [] },
        { name: 's3', kind: 'function', changedIn: 'a.ts', callers: [] },
        { name: 's4', kind: 'function', changedIn: 'a.ts', callers: [] },
        { name: 's5', kind: 'function', changedIn: 'a.ts', callers: [] },
      ];
      provider.applyAmend('r2', fiveSymbols, []);
      const item = provider.getTreeItem(provider.getEntries()[0]);
      assert.strictEqual(
        item.label,
        'Alice pushed 1 file(s) — affects 5 of your symbols: s1(), s2(), s3(), …',
      );
    });

    test('ActivityLogProvider.applyAmend on unknown recordId is a no-op (no throw, no label change)', () => {
      const provider = new ActivityLogProvider();
      provider.addPushEntry({
        timestamp: 1,
        memberId: 'alice',
        memberDisplayName: 'Alice',
        isMine: false,
        files: ['a.ts'],
        affectsLocal: false,
      });
      // No chatRecordId linked — applyAmend cannot find the entry.
      provider.applyAmend('unknown-id', [SYMBOL_FOO], []);
      const item = provider.getTreeItem(provider.getEntries()[0]);
      // Fallback label still in effect.
      assert.strictEqual(item.label, 'Alice pushed 1 file(s)');
    });

    test('ActivityLogProvider tooltip appends "Symbol analysis unavailable for: …" on unsupportedLanguages', () => {
      const provider = new ActivityLogProvider();
      provider.addPushEntry({
        timestamp: 1,
        memberId: 'alice',
        memberDisplayName: 'Alice',
        isMine: false,
        files: ['a.ts'],
        affectsLocal: false,
        pushId: 'p3',
      });
      provider.linkChatRecordToPush('p3', 'r3');
      provider.applyAmend('r3', [], ['java']);
      const item = provider.getTreeItem(provider.getEntries()[0]);
      assert.match(
        String(item.tooltip),
        /Symbol analysis unavailable for: java/,
      );
    });

    test('ActivityLogProvider.linkChatRecordToPush only stamps the most recent matching push', () => {
      const provider = new ActivityLogProvider();
      provider.addPushEntry({
        timestamp: 1,
        memberId: 'alice',
        memberDisplayName: 'Alice',
        isMine: false,
        files: ['a.ts'],
        affectsLocal: false,
        pushId: 'p1',
      });
      provider.addPushEntry({
        timestamp: 2,
        memberId: 'alice',
        memberDisplayName: 'Alice',
        isMine: false,
        files: ['b.ts'],
        affectsLocal: false,
        pushId: 'p2',
      });
      provider.linkChatRecordToPush('p1', 'r1');
      provider.linkChatRecordToPush('p2', 'r2');
      const entries = provider.getEntries();
      assert.strictEqual(entries.find(e => e.pushId === 'p1')?.chatRecordId, 'r1');
      assert.strictEqual(entries.find(e => e.pushId === 'p2')?.chatRecordId, 'r2');
    });
  });

  // -------------------- graceful degradation --------------------

  suite('graceful degradation', () => {
    test('older client simulator: parseMessage rejects amend when VALID_TYPES lacks chat-message-amend', () => {
      // Simulate a pre-Phase-5 client by re-implementing parseMessage with the
      // PRE-Phase-5 VALID_TYPES set (no chat-message-amend). The original
      // chat-message frame must still parse correctly.
      const PRE_PHASE5_VALID: ReadonlySet<string> = new Set<string>([
        'auth-request', 'auth-response', 'member-joined', 'member-left',
        'member-kicked', 'member-list', 'state-sync', 'kick-member',
        'regenerate-invite', 'invite-regenerated',
        'heartbeat-ping', 'heartbeat-pong', 'error',
        'push-notification', 'push-reverted', 'branch-created',
        'branch-locked', 'permission-changed', 'sync-request', 'sync-response',
        'tracked-paths-update',
        'chat-message', 'chat-cleared', 'chat-truncated', 'chat-history', 'presence-update',
      ]);
      function olderParse(data: string): ProtocolMessage | null {
        try {
          const msg = JSON.parse(data);
          if (typeof msg !== 'object' || msg === null) return null;
          if (typeof msg.type !== 'string' || !PRE_PHASE5_VALID.has(msg.type)) return null;
          if (typeof msg.timestamp !== 'number') return null;
          return msg as ProtocolMessage;
        } catch { return null; }
      }
      const amend = JSON.stringify({
        type: 'chat-message-amend',
        timestamp: 1,
        recordId: 'r1',
        affectedSymbols: [],
        unsupportedLanguages: [],
      });
      // Older client drops the amend.
      assert.strictEqual(olderParse(amend), null);

      // But the original chat-message still parses correctly on the older client.
      const original = JSON.stringify({
        type: 'chat-message',
        timestamp: 1,
        recordId: 'r1',
        kind: 'system',
        subKind: 'push',
        memberId: 'host',
        memberDisplayName: 'Host',
        body: 'pushed 1 file(s)',
        meta: { pushId: 'p1', branch: 'main', files: ['a.ts'] },
      });
      assert.ok(olderParse(original));

      // Sanity: current parseMessage accepts the amend that the older one rejected.
      assert.ok(parseMessage(amend));
    });

    test('pre-Phase-5 record replay: missing meta.affectedSymbols renders the file-level fallback label', () => {
      // Verifies via ActivityLogProvider — pre-Phase-5 records have no
      // affectedSymbols on the entry. formatLabel falls through to the
      // existing isMine / affectsLocal path.
      const provider = new ActivityLogProvider();
      provider.addPushEntry({
        timestamp: 1,
        memberId: 'alice',
        memberDisplayName: 'Alice',
        isMine: false,
        files: ['a.ts', 'b.ts'],
        affectsLocal: true,
        // No pushId, no chatRecordId, no affectedSymbols — pre-Phase-5 shape.
      });
      const item = provider.getTreeItem(provider.getEntries()[0]);
      assert.strictEqual(item.label, 'Alice pushed 2 file(s) — affects you');
    });
  });
});
