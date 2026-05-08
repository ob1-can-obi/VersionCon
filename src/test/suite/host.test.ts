import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { WebSocket } from 'ws';
import { SessionHost } from '../../host/SessionHost.js';
import { ChatLog } from '../../filesystem/ChatLog.js';
import type { ChatRecord, PresenceInfo } from '../../types/chat.js';
import type {
  ProtocolMessage,
  ChatMessage,
  ChatHistory,
  PresenceUpdate,
} from '../../network/protocol.js';
import type { SessionConfig } from '../../types/session.js';
import type { PushRecord, PushFileEntry } from '../../types/push.js';
import type { BranchInfo } from '../../types/branch.js';

// NET-01: Host can create a LAN session
suite('SessionHost', () => {
  suite('start', () => {
    test('should start WebSocket server on specified port (NET-01)');
    test('should find and use a free port when port is 0 (NET-01)');
    test('should enforce maxPayload limit (NET-08)');
    test('should set perMessageDeflate to false (LAN optimization)');
  });

  suite('heartbeat', () => {
    test('should terminate members that miss heartbeat');
    test('should broadcast member-left when terminated');
  });

  suite('member management', () => {
    test('should track connected members');
    test('should broadcast member-joined to existing members');
    test('should broadcast member-left on disconnect');
  });
});

// NET-08: Bandwidth limits
suite('BandwidthMonitor', () => {
  test('should track bytes sent per member');
  test('should track bytes received per member');
  test('should calculate rate in KB/s');
  test('should remove member stats on disconnect');
});

// SAFE-01: Host is source of truth
suite('AuthHandler', () => {
  test('should validate invite code with constant-time comparison (SAFE-01)');
  test('should reject invalid invite codes');
  test('should rate limit auth attempts per IP (5/minute)');
  test('should regenerate invite code with safe alphabet');
  test('should use ABCDEFGHJKLMNPQRSTUVWXYZ23456789 alphabet');
});

// ---------------------------------------------------------------------------
// Phase 4 host relay (Plan 04-04) — integration tests
//
// The host is the trusted source of truth for chat persistence and presence
// accumulation. These tests boot a real SessionHost on an ephemeral port,
// connect WebSocket clients, and verify:
//
// 1. server-trust: host overrides client-claimed memberId / timestamp
//    before persisting + broadcasting (T-04-04-01, T-04-04-02)
// 2. fan-out policy: chat-message broadcasts to ALL (sender included),
//    presence-update broadcasts to all EXCEPT sender
// 3. lifecycle: member-left clears the presence map entry
// 4. replay: chat-history is delivered after state-sync on auth handshake
// ---------------------------------------------------------------------------

const INVITE = 'ABCDEFGH';
const HOST_NAME = 'HostUser';
const MAX_PAYLOAD = 1_000_000;

interface TestClient {
  ws: WebSocket;
  memberId: string;
  send(msg: ProtocolMessage): void;
  close(): Promise<void>;
  /** Resolves on the next message of `type`. */
  waitFor(type: string, timeoutMs?: number): Promise<ProtocolMessage>;
  /** Subscribe to all incoming messages. */
  onMessage(fn: (m: ProtocolMessage) => void): void;
}

async function connectClient(
  port: number,
  displayName: string,
): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const listeners = new Set<(m: ProtocolMessage) => void>();
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as ProtocolMessage;
      for (const fn of listeners) {
        try { fn(msg); } catch { /* ignore */ }
      }
    } catch { /* malformed — ignore */ }
  });

  // Send auth-request, await auth-response.
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
  const memberId = authResp.memberId;

  return {
    ws,
    memberId,
    send: (msg: ProtocolMessage) => ws.send(JSON.stringify(msg)),
    close: () => new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
      ws.once('close', () => resolve());
      ws.close();
    }),
    waitFor: (type: string, timeoutMs = 2000) =>
      new Promise<ProtocolMessage>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`waitFor(${type}) timeout`)),
          timeoutMs,
        );
        const handler = (m: ProtocolMessage): void => {
          if (m.type === type) {
            clearTimeout(timer);
            listeners.delete(handler);
            resolve(m);
          }
        };
        listeners.add(handler);
      }),
    onMessage: (fn) => { listeners.add(fn); },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  pollMs = 25,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor predicate timeout');
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

suite('Phase 4 host relay', () => {
  let host: SessionHost;
  let chatLog: ChatLog;
  let tmpDir: string;
  let port: number;

  setup(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `vc-host-relay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const branchDir = path.join(tmpDir, 'branch');
    await fs.mkdir(branchDir, { recursive: true });
    chatLog = new ChatLog(branchDir);
    await chatLog.load();

    const config: SessionConfig = {
      sessionName: 'Phase4Test',
      port: 0,
      networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD,
      inviteCode: INVITE,
    };
    host = new SessionHost(config, HOST_NAME);
    host.setChatLog(chatLog, 'main');
    port = await host.start();
  });

  teardown(async () => {
    try { host.stop(); } catch { /* best-effort */ }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('chat-message: host overrides client-claimed memberId with ws-authed memberId', async () => {
    const alice = await connectClient(port, 'Alice');

    alice.send({
      type: 'chat-message',
      timestamp: 1, // client-stamped — host will override
      recordId: 'r1',
      kind: 'user',
      memberId: 'bob-attacker', // claimed
      memberDisplayName: 'BobAttacker', // claimed
      body: 'hello',
    });

    await waitFor(() => chatLog.getRecords().length === 1);
    const records = chatLog.getRecords();
    assert.strictEqual(records.length, 1);
    assert.strictEqual(
      records[0].memberId,
      alice.memberId,
      'host overrode claimed bob-attacker → ws-authed alice id',
    );
    assert.notStrictEqual(records[0].memberId, 'bob-attacker', 'claimed memberId rejected');
    assert.strictEqual(
      records[0].memberDisplayName,
      'Alice',
      'displayName resolved from host members map, not the claimed value',
    );

    await alice.close();
  });

  test('chat-message: host stamps server timestamp', async () => {
    const alice = await connectClient(port, 'Alice');
    const beforeMs = Date.now();

    alice.send({
      type: 'chat-message',
      timestamp: 1, // garbage client clock
      recordId: 'r1',
      kind: 'user',
      memberId: alice.memberId,
      memberDisplayName: 'Alice',
      body: 'msg',
    });

    await waitFor(() => chatLog.getRecords().length === 1);
    const r = chatLog.getRecords()[0];
    assert.ok(
      r.timestamp >= beforeMs,
      `host timestamp (${r.timestamp}) >= test start (${beforeMs})`,
    );
    assert.notStrictEqual(r.timestamp, 1, 'client timestamp 1 was overridden');

    await alice.close();
  });

  test('chat-message: broadcast includes sender (no exclude)', async () => {
    const alice = await connectClient(port, 'Alice');
    const senderReceived: ChatMessage[] = [];
    alice.onMessage((m) => {
      if (m.type === 'chat-message') {
        senderReceived.push(m);
      }
    });

    alice.send({
      type: 'chat-message',
      timestamp: 1,
      recordId: 'r1',
      kind: 'user',
      memberId: alice.memberId,
      memberDisplayName: 'Alice',
      body: 'echo me',
    });

    await waitFor(() => senderReceived.length === 1);
    assert.strictEqual(senderReceived[0].body, 'echo me', 'sender received own message');
    assert.strictEqual(
      senderReceived[0].memberId,
      alice.memberId,
      'echoed message carries server-trusted memberId',
    );

    await alice.close();
  });

  test('presence-update: host overrides memberId and broadcasts (excludes sender)', async () => {
    const alice = await connectClient(port, 'Alice');
    const bob = await connectClient(port, 'Bob');

    const aliceReceived: PresenceUpdate[] = [];
    const bobReceived: PresenceUpdate[] = [];
    alice.onMessage((m) => {
      if (m.type === 'presence-update') { aliceReceived.push(m); }
    });
    bob.onMessage((m) => {
      if (m.type === 'presence-update') { bobReceived.push(m); }
    });

    alice.send({
      type: 'presence-update',
      timestamp: 1,
      memberId: 'attacker-id', // claimed
      displayName: 'evil', // claimed
      branch: 'main',
      activeFilePath: 'src/foo.ts',
    });

    await waitFor(() => bobReceived.length === 1);
    assert.strictEqual(
      bobReceived[0].memberId,
      alice.memberId,
      'override applied — receivers see ws-authed id, not the claimed attacker id',
    );
    assert.strictEqual(
      bobReceived[0].displayName,
      'Alice',
      'receivers see server-resolved displayName, not the claimed value',
    );
    assert.strictEqual(bobReceived[0].activeFilePath, 'src/foo.ts');
    assert.strictEqual(aliceReceived.length, 0, 'sender excluded from broadcast');

    // Host's own presenceMap should reflect the override.
    const snapshot = host.getPresenceSnapshot();
    const aliceEntry = snapshot.find((p) => p.memberId === alice.memberId);
    assert.ok(aliceEntry, 'alice entry exists in presence snapshot');
    assert.strictEqual(aliceEntry.activeFilePath, 'src/foo.ts');

    await alice.close();
    await bob.close();
  });

  test('member-left clears presence entry', async () => {
    const alice = await connectClient(port, 'Alice');
    alice.send({
      type: 'presence-update',
      timestamp: 1,
      memberId: alice.memberId,
      displayName: 'Alice',
      branch: 'main',
      activeFilePath: 'src/foo.ts',
    });
    await waitFor(() => host.getPresenceSnapshot().length === 1);
    assert.strictEqual(host.getPresenceSnapshot().length, 1);

    await alice.close();
    await waitFor(() => host.getPresenceSnapshot().length === 0);
    assert.strictEqual(
      host.getPresenceSnapshot().length,
      0,
      'presence entry removed on disconnect',
    );
  });

  test('sendChatHistoryToMember: auth handshake delivers last-100 records as chat-history after state-sync', async () => {
    // Pre-populate the chat log with 5 records BEFORE connecting.
    for (let i = 1; i <= 5; i++) {
      await chatLog.append({
        id: 'r' + i,
        kind: 'user',
        memberId: 'preexisting',
        memberDisplayName: 'Pre',
        body: 'msg' + i,
        timestamp: i * 1000,
      });
    }

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox: ProtocolMessage[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.on('message', (raw: Buffer) => {
      try { inbox.push(JSON.parse(raw.toString()) as ProtocolMessage); } catch {}
    });

    ws.send(JSON.stringify({
      type: 'auth-request',
      timestamp: Date.now(),
      inviteCode: INVITE,
      displayName: 'Joiner',
    }));

    await waitFor(() => inbox.some((m) => m.type === 'chat-history'));
    const history = inbox.find((m) => m.type === 'chat-history') as ChatHistory;
    assert.ok(history, 'chat-history was sent during auth handshake');
    assert.strictEqual(history.branch, 'main');
    assert.strictEqual(history.records.length, 5);
    assert.strictEqual(history.records[0].id, 'r1');
    assert.strictEqual(history.records[4].id, 'r5');

    // Order check: chat-history must arrive AFTER state-sync per RESEARCH Open Q #2.
    const stateSyncIdx = inbox.findIndex((m) => m.type === 'state-sync');
    const chatHistoryIdx = inbox.findIndex((m) => m.type === 'chat-history');
    assert.ok(stateSyncIdx >= 0, 'state-sync was sent');
    assert.ok(
      chatHistoryIdx > stateSyncIdx,
      `chat-history (idx ${chatHistoryIdx}) must arrive AFTER state-sync (idx ${stateSyncIdx})`,
    );

    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      ws.close();
    });
  });

  test('sendChatHistoryToMember: getRecent(100) cap — older messages are dropped on replay', async () => {
    // Pre-populate 105 records; only the last 100 should be replayed.
    for (let i = 1; i <= 105; i++) {
      await chatLog.append({
        id: 'r' + String(i).padStart(3, '0'),
        kind: 'user',
        memberId: 'preexisting',
        memberDisplayName: 'Pre',
        body: 'msg' + i,
        timestamp: i * 1000,
      });
    }

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox: ProtocolMessage[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.on('message', (raw: Buffer) => {
      try { inbox.push(JSON.parse(raw.toString()) as ProtocolMessage); } catch {}
    });

    ws.send(JSON.stringify({
      type: 'auth-request',
      timestamp: Date.now(),
      inviteCode: INVITE,
      displayName: 'Joiner',
    }));

    await waitFor(() => inbox.some((m) => m.type === 'chat-history'));
    const history = inbox.find((m) => m.type === 'chat-history') as ChatHistory;
    assert.strictEqual(history.records.length, 100, 'replay window capped at 100');
    assert.strictEqual(history.records[0].id, 'r006', 'oldest 5 records (r001..r005) dropped');
    assert.strictEqual(history.records[99].id, 'r105', 'most recent record present');

    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      ws.close();
    });
  });

  test('chat-cleared and chat-truncated have NO inbound handler — silently ignored (T-04-04-04)', async () => {
    // A non-host member tries to spoof a chat-cleared event over the wire.
    // The host's onmessage switch has no branch for these types; the message
    // should silently drop. We verify by:
    //   1. confirming the broadcast NEVER reaches another connected client
    //   2. confirming the host did not crash (subsequent chat-message still works)
    const alice = await connectClient(port, 'Alice');
    const bob = await connectClient(port, 'Bob');

    const bobReceivedCleared: ProtocolMessage[] = [];
    bob.onMessage((m) => {
      if (m.type === 'chat-cleared' || m.type === 'chat-truncated') {
        bobReceivedCleared.push(m);
      }
    });

    // Spoof attempt — alice sends host-only outbound types.
    alice.send({
      type: 'chat-cleared',
      timestamp: 1,
      hostMemberId: alice.memberId,
      hostDisplayName: 'Alice',
    });
    alice.send({
      type: 'chat-truncated',
      timestamp: 1,
      mode: 'activity-only',
      hostMemberId: alice.memberId,
      hostDisplayName: 'Alice',
    });

    // Give the host a moment to process — then send a known-good chat-message
    // so we can pivot on its arrival to confirm bob's inbox is otherwise idle.
    const bobReceivedChat: ChatMessage[] = [];
    bob.onMessage((m) => {
      if (m.type === 'chat-message') { bobReceivedChat.push(m); }
    });
    alice.send({
      type: 'chat-message',
      timestamp: 1,
      recordId: 'r-after-spoof',
      kind: 'user',
      memberId: alice.memberId,
      memberDisplayName: 'Alice',
      body: 'still works',
    });

    await waitFor(() => bobReceivedChat.length === 1);
    assert.strictEqual(
      bobReceivedCleared.length,
      0,
      'spoofed chat-cleared / chat-truncated were silently dropped — never broadcast',
    );
    assert.strictEqual(
      bobReceivedChat[0].body,
      'still works',
      'host did not crash from the spoofed messages — chat-message handling continues',
    );

    await alice.close();
    await bob.close();
  });

  test('handleLocalChatMessage: host-local compose path persists + broadcasts identically to wire handler', async () => {
    const alice = await connectClient(port, 'Alice');
    const aliceReceived: ChatMessage[] = [];
    alice.onMessage((m) => {
      if (m.type === 'chat-message') { aliceReceived.push(m); }
    });

    await host.handleLocalChatMessage({
      recordId: 'r-host-1',
      kind: 'user',
      body: 'hi from host',
    });

    await waitFor(() => aliceReceived.length === 1);
    assert.strictEqual(aliceReceived[0].body, 'hi from host');
    assert.strictEqual(aliceReceived[0].recordId, 'r-host-1');
    assert.strictEqual(
      aliceReceived[0].memberDisplayName,
      HOST_NAME,
      'broadcast carries host displayName',
    );

    // Same persistence path as the wire handler — record is in chatLog.
    const records = chatLog.getRecords();
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].id, 'r-host-1');
    assert.strictEqual(records[0].body, 'hi from host');
    assert.strictEqual(records[0].memberDisplayName, HOST_NAME);

    await alice.close();
  });

  test('upsertHostPresence: host appears in presence snapshot and broadcast reaches all clients', async () => {
    const alice = await connectClient(port, 'Alice');
    const aliceReceived: PresenceUpdate[] = [];
    alice.onMessage((m) => {
      if (m.type === 'presence-update') { aliceReceived.push(m); }
    });

    const hostInfo: PresenceInfo = {
      memberId: 'host-id',
      displayName: HOST_NAME,
      branch: 'main',
      activeFilePath: 'src/extension.ts',
      lastUpdated: Date.now(),
    };
    host.upsertHostPresence(hostInfo);

    await waitFor(() => aliceReceived.length === 1);
    assert.strictEqual(aliceReceived[0].memberId, 'host-id');
    assert.strictEqual(aliceReceived[0].displayName, HOST_NAME);
    assert.strictEqual(aliceReceived[0].activeFilePath, 'src/extension.ts');

    const snapshot = host.getPresenceSnapshot();
    const hostEntry = snapshot.find((p) => p.memberId === 'host-id');
    assert.ok(hostEntry, 'host presence entry exists');
    assert.strictEqual(hostEntry.activeFilePath, 'src/extension.ts');

    await alice.close();
  });

  test('broadcastChatCleared and broadcastChatTruncated reach all connected members', async () => {
    const alice = await connectClient(port, 'Alice');
    const bob = await connectClient(port, 'Bob');

    const aliceCleared: ProtocolMessage[] = [];
    const bobCleared: ProtocolMessage[] = [];
    const aliceTruncated: ProtocolMessage[] = [];
    const bobTruncated: ProtocolMessage[] = [];
    alice.onMessage((m) => {
      if (m.type === 'chat-cleared') { aliceCleared.push(m); }
      if (m.type === 'chat-truncated') { aliceTruncated.push(m); }
    });
    bob.onMessage((m) => {
      if (m.type === 'chat-cleared') { bobCleared.push(m); }
      if (m.type === 'chat-truncated') { bobTruncated.push(m); }
    });

    host.broadcastChatCleared('host-id', HOST_NAME);
    host.broadcastChatTruncated('keep-100-and-activity', 'host-id', HOST_NAME);

    await waitFor(() => aliceCleared.length === 1 && bobCleared.length === 1);
    await waitFor(() => aliceTruncated.length === 1 && bobTruncated.length === 1);

    // chat-cleared payload check
    const cleared = aliceCleared[0];
    assert.strictEqual(cleared.type, 'chat-cleared');
    if (cleared.type === 'chat-cleared') {
      assert.strictEqual(cleared.hostMemberId, 'host-id');
      assert.strictEqual(cleared.hostDisplayName, HOST_NAME);
    }

    // chat-truncated payload check
    const truncated = bobTruncated[0];
    assert.strictEqual(truncated.type, 'chat-truncated');
    if (truncated.type === 'chat-truncated') {
      assert.strictEqual(truncated.mode, 'keep-100-and-activity');
      assert.strictEqual(truncated.hostMemberId, 'host-id');
    }

    await alice.close();
    await bob.close();
  });
});

// ---------------------------------------------------------------------------
// Phase 4 host input validation (Plan 04-13) — defends the chat-message and
// presence-update wire handlers against:
//
//   CR-01: client-authored kind:'system' chat frames spoofing system events
//   CR-02: presence-update activeFilePath path-traversal / absolute / backslash
//   CR-03: oversized or malformed chat-message body / recordId
//
// Reuses connectClient / waitFor helpers defined above the 'Phase 4 host
// relay' suite. Same fixture shape (ephemeral port, tmp ChatLog) so each test
// boots a fresh host.
// ---------------------------------------------------------------------------

suite('Phase 4 host input validation', () => {
  let host: SessionHost;
  let chatLog: ChatLog;
  let tmpDir: string;
  let port: number;

  setup(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `vc-host-input-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const branchDir = path.join(tmpDir, 'branch');
    await fs.mkdir(branchDir, { recursive: true });
    chatLog = new ChatLog(branchDir);
    await chatLog.load();

    const config: SessionConfig = {
      sessionName: 'Phase4ValidationTest',
      port: 0,
      networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD,
      inviteCode: INVITE,
    };
    host = new SessionHost(config, HOST_NAME);
    host.setChatLog(chatLog, 'main');
    port = await host.start();
  });

  teardown(async () => {
    try { host.stop(); } catch { /* best-effort */ }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("chat-message: client-authored kind:'system' is coerced to 'user' before persist (CR-01)", async () => {
    const alice = await connectClient(port, 'Alice');
    const bob = await connectClient(port, 'Bob');
    const bobReceived: ChatMessage[] = [];
    bob.onMessage((m) => {
      if (m.type === 'chat-message') { bobReceived.push(m); }
    });

    alice.send({
      type: 'chat-message',
      timestamp: 1,
      recordId: 'r-forge-1',
      kind: 'system',                   // forged
      subKind: 'push',                  // forged
      memberId: alice.memberId,
      memberDisplayName: 'Alice',
      body: 'forged push event',
      meta: { pushId: 'fake-push-id', branch: 'main', files: ['src/foo.ts'] },
    });

    await waitFor(() => chatLog.getRecords().length === 1);
    const records = chatLog.getRecords();
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].kind, 'user', 'forged kind:system coerced to user');
    assert.strictEqual(records[0].subKind, undefined, 'forged subKind stripped');
    assert.strictEqual(records[0].meta, undefined, 'forged meta stripped');

    // Broadcast envelope also coerced — bob sees kind:'user' with no subKind/meta.
    await waitFor(() => bobReceived.length === 1);
    assert.strictEqual(bobReceived[0].kind, 'user', 'broadcast kind coerced to user');
    assert.strictEqual(bobReceived[0].subKind, undefined, 'broadcast subKind stripped');
    assert.strictEqual(bobReceived[0].meta, undefined, 'broadcast meta stripped');

    await alice.close();
    await bob.close();
  });

  test('chat-message: body > 65536 chars is dropped silently (CR-03)', async () => {
    const alice = await connectClient(port, 'Alice');
    const lengthBefore = chatLog.getRecords().length;
    alice.send({
      type: 'chat-message',
      timestamp: 1,
      recordId: 'r-big-1',
      kind: 'user',
      memberId: alice.memberId,
      memberDisplayName: 'Alice',
      body: 'x'.repeat(65537),
    });
    // Wait long enough for the host to have processed if it were going to.
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(
      chatLog.getRecords().length,
      lengthBefore,
      'oversized body dropped',
    );

    await alice.close();
  });

  test('chat-message: empty body is dropped silently (CR-03)', async () => {
    const alice = await connectClient(port, 'Alice');
    const lengthBefore = chatLog.getRecords().length;
    alice.send({
      type: 'chat-message',
      timestamp: 1,
      recordId: 'r-empty-1',
      kind: 'user',
      memberId: alice.memberId,
      memberDisplayName: 'Alice',
      body: '',
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(
      chatLog.getRecords().length,
      lengthBefore,
      'empty body dropped',
    );

    await alice.close();
  });

  test('chat-message: recordId > 128 chars is dropped silently (CR-03)', async () => {
    const alice = await connectClient(port, 'Alice');
    const lengthBefore = chatLog.getRecords().length;
    alice.send({
      type: 'chat-message',
      timestamp: 1,
      recordId: 'r'.repeat(129),
      kind: 'user',
      memberId: alice.memberId,
      memberDisplayName: 'Alice',
      body: 'hello',
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(
      chatLog.getRecords().length,
      lengthBefore,
      'oversized recordId dropped',
    );

    await alice.close();
  });

  test("presence-update: activeFilePath with '..' is dropped silently (CR-02)", async () => {
    const alice = await connectClient(port, 'Alice');
    const bob = await connectClient(port, 'Bob');
    const bReceived: PresenceUpdate[] = [];
    bob.onMessage((m) => {
      if (m.type === 'presence-update') { bReceived.push(m); }
    });

    alice.send({
      type: 'presence-update',
      timestamp: 1,
      memberId: alice.memberId,
      displayName: 'Alice',
      branch: 'main',
      activeFilePath: '../../../../etc/passwd',
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(
      bReceived.length,
      0,
      'path traversal dropped — no broadcast',
    );
    const snapshot = host.getPresenceSnapshot();
    const entry = snapshot.find((p) => p.memberId === alice.memberId);
    assert.ok(
      !entry || entry.activeFilePath !== '../../../../etc/passwd',
      'PresenceMap not poisoned',
    );

    await alice.close();
    await bob.close();
  });

  test("presence-update: absolute POSIX path '/etc/passwd' is dropped silently (CR-02)", async () => {
    const alice = await connectClient(port, 'Alice');
    const bob = await connectClient(port, 'Bob');
    const bReceived: PresenceUpdate[] = [];
    bob.onMessage((m) => {
      if (m.type === 'presence-update') { bReceived.push(m); }
    });

    alice.send({
      type: 'presence-update',
      timestamp: 1,
      memberId: alice.memberId,
      displayName: 'Alice',
      branch: 'main',
      activeFilePath: '/etc/passwd',
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(bReceived.length, 0, 'absolute path dropped');

    await alice.close();
    await bob.close();
  });

  test("presence-update: Windows absolute path 'C:\\\\Users\\\\victim' is dropped silently (CR-02)", async () => {
    const alice = await connectClient(port, 'Alice');
    const bob = await connectClient(port, 'Bob');
    const bReceived: PresenceUpdate[] = [];
    bob.onMessage((m) => {
      if (m.type === 'presence-update') { bReceived.push(m); }
    });

    alice.send({
      type: 'presence-update',
      timestamp: 1,
      memberId: alice.memberId,
      displayName: 'Alice',
      branch: 'main',
      activeFilePath: 'C:\\Users\\victim',
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(bReceived.length, 0, 'Windows absolute path dropped');

    await alice.close();
    await bob.close();
  });

  test("presence-update: relative path with backslash 'src\\\\foo.ts' is dropped silently (CR-02)", async () => {
    // This input has NO Windows drive prefix, so the /^[A-Za-z]:[\\/]/ regex
    // does NOT fire. The standalone `p.includes('\\')` branch is what rejects
    // it. Without this dedicated test, the backslash check is unexercised
    // (the C:\Users\victim test matches the regex first and short-circuits
    // the OR before the includes('\\') term evaluates).
    const alice = await connectClient(port, 'Alice');
    const bob = await connectClient(port, 'Bob');
    const bReceived: PresenceUpdate[] = [];
    bob.onMessage((m) => {
      if (m.type === 'presence-update') { bReceived.push(m); }
    });

    alice.send({
      type: 'presence-update',
      timestamp: 1,
      memberId: alice.memberId,
      displayName: 'Alice',
      branch: 'main',
      activeFilePath: 'src\\foo.ts',
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(
      bReceived.length,
      0,
      'relative path with backslash dropped',
    );
    const snapshot = host.getPresenceSnapshot();
    const entry = snapshot.find((p) => p.memberId === alice.memberId);
    assert.ok(
      !entry || entry.activeFilePath !== 'src\\foo.ts',
      'PresenceMap not poisoned by backslash path',
    );

    await alice.close();
    await bob.close();
  });

  test('presence-update: 1025-char path is dropped silently (CR-02)', async () => {
    const alice = await connectClient(port, 'Alice');
    const bob = await connectClient(port, 'Bob');
    const bReceived: PresenceUpdate[] = [];
    bob.onMessage((m) => {
      if (m.type === 'presence-update') { bReceived.push(m); }
    });

    alice.send({
      type: 'presence-update',
      timestamp: 1,
      memberId: alice.memberId,
      displayName: 'Alice',
      branch: 'main',
      activeFilePath: 'a'.repeat(1025),
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(bReceived.length, 0, 'oversized path dropped');

    await alice.close();
    await bob.close();
  });

  test('presence-update: null activeFilePath is preserved (CR-02 negative)', async () => {
    const alice = await connectClient(port, 'Alice');
    const bob = await connectClient(port, 'Bob');
    const bReceived: PresenceUpdate[] = [];
    bob.onMessage((m) => {
      if (m.type === 'presence-update') { bReceived.push(m); }
    });

    alice.send({
      type: 'presence-update',
      timestamp: 1,
      memberId: alice.memberId,
      displayName: 'Alice',
      branch: 'main',
      activeFilePath: null,
    });
    await waitFor(() => bReceived.length === 1, 1000);
    assert.strictEqual(bReceived[0].activeFilePath, null, 'null preserved');

    await alice.close();
    await bob.close();
  });
});

// ---------------------------------------------------------------------------
// Phase 4 system events in chat (Plan 04-12)
//
// broadcastPush / broadcastRevert / broadcastBranchCreated must:
//   1. Append a kind:'system' ChatRecord to chat-log.json with the matching
//      subKind ('push' | 'revert' | 'branch-created') and meta:{ pushId,
//      branch, files }.
//   2. Broadcast a chat-message envelope to ALL connected members (no
//      exclude) so the activity timeline updates live — same fan-out as
//      handleLocalChatMessage from Plan 04-04.
//   3. Use this.hostMemberId ?? 'host' as memberId and this.hostDisplayName
//      as memberDisplayName (mirrors handleLocalChatMessage).
//   4. Emit a body string per UI-SPEC §6.3 / activity tree label format:
//        "{hostDisplayName} pushed {N} file(s)"
//        "{hostDisplayName} reverted {N} file(s)"
//        "{hostDisplayName} created branch '{branchName}'"
//   5. Preserve the Phase 3 wire-broadcast contract — original
//      push-notification / push-reverted / branch-created envelopes still
//      fire unconditionally (a chat-log persistence failure must NOT
//      regress Phase 3 fan-out).
//   6. Coexist with Plan 04-13 CR-01 client-frame coercion — host-internal
//      kind:'system' writes are legitimate; the wire validator only coerces
//      client-authored chat-message frames.
//
// Reuses connectClient / waitFor module-scope helpers.
// ---------------------------------------------------------------------------

suite('Phase 4 system events in chat', () => {
  let host: SessionHost;
  let chatLog: ChatLog;
  let tmpDir: string;
  let port: number;

  setup(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `vc-host-system-events-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const branchDir = path.join(tmpDir, 'branch');
    await fs.mkdir(branchDir, { recursive: true });
    chatLog = new ChatLog(branchDir);
    await chatLog.load();

    const config: SessionConfig = {
      sessionName: 'Phase4SystemEvents',
      port: 0,
      networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD,
      inviteCode: INVITE,
    };
    host = new SessionHost(config, HOST_NAME);
    host.setChatLog(chatLog, 'main');
    port = await host.start();
  });

  teardown(async () => {
    try { host.stop(); } catch { /* best-effort */ }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------- broadcastPush --------------------

  test("broadcastPush appends kind:'system' subKind:'push' ChatRecord with meta", async () => {
    const files: PushFileEntry[] = [
      { relativePath: 'src/foo.ts', status: 'modified', addedLines: 10, removedLines: 2 },
      { relativePath: 'src/bar.ts', status: 'added', addedLines: 50, removedLines: 0 },
    ];
    const record: PushRecord = {
      id: 'push-id-1',
      memberId: 'host-id',
      memberDisplayName: HOST_NAME,
      message: 'Wire up token refresh',
      branch: 'main',
      files,
      timestamp: Date.now(),
      reverted: false,
    };

    host.broadcastPush(record);

    await waitFor(() => chatLog.getRecords().length === 1);
    const persisted = chatLog.getRecords();
    assert.strictEqual(persisted.length, 1);
    const r = persisted[0];
    assert.strictEqual(r.kind, 'system', 'kind is system (not user)');
    assert.strictEqual(r.subKind, 'push', 'subKind is push');
    assert.strictEqual(r.body, `${HOST_NAME} pushed 2 file(s)`, 'body matches UI-SPEC §6.3 format');
    assert.ok(r.meta, 'meta present');
    assert.strictEqual(r.meta.pushId, 'push-id-1');
    assert.strictEqual(r.meta.branch, 'main');
    assert.deepStrictEqual(r.meta.files, ['src/foo.ts', 'src/bar.ts']);
  });

  test('broadcastPush broadcasts chat-message envelope to all connected clients', async () => {
    const alice = await connectClient(port, 'Alice');
    const bob = await connectClient(port, 'Bob');
    const aliceChat: ChatMessage[] = [];
    const bobChat: ChatMessage[] = [];
    alice.onMessage((m) => { if (m.type === 'chat-message') { aliceChat.push(m); } });
    bob.onMessage((m) => { if (m.type === 'chat-message') { bobChat.push(m); } });

    const record: PushRecord = {
      id: 'push-id-2',
      memberId: 'host-id',
      memberDisplayName: HOST_NAME,
      message: 'msg',
      branch: 'feature-x',
      files: [{ relativePath: 'a.ts', status: 'modified', addedLines: 1, removedLines: 0 }],
      timestamp: Date.now(),
      reverted: false,
    };

    host.broadcastPush(record);

    await waitFor(() => aliceChat.length === 1 && bobChat.length === 1);
    const env = aliceChat[0];
    assert.strictEqual(env.kind, 'system', 'wire envelope is kind:system');
    assert.strictEqual(env.subKind, 'push');
    assert.strictEqual(env.body, `${HOST_NAME} pushed 1 file(s)`);
    assert.strictEqual(env.memberDisplayName, HOST_NAME, 'envelope memberDisplayName = hostDisplayName');
    assert.ok(env.meta);
    assert.strictEqual(env.meta.pushId, 'push-id-2');
    assert.strictEqual(env.meta.branch, 'feature-x');
    assert.deepStrictEqual(env.meta.files, ['a.ts']);
    assert.strictEqual(bobChat[0].body, env.body, 'all connected clients receive the same body');

    await alice.close();
    await bob.close();
  });

  test('broadcastPush still fires the original push-notification wire envelope (Phase 3 contract)', async () => {
    const alice = await connectClient(port, 'Alice');
    const aliceNotifs: ProtocolMessage[] = [];
    alice.onMessage((m) => {
      if (m.type === 'push-notification') { aliceNotifs.push(m); }
    });

    const record: PushRecord = {
      id: 'push-id-3',
      memberId: 'host-id',
      memberDisplayName: HOST_NAME,
      message: 'fix bug',
      branch: 'main',
      files: [{ relativePath: 'x.ts', status: 'modified', addedLines: 5, removedLines: 3 }],
      timestamp: Date.now(),
      reverted: false,
    };

    host.broadcastPush(record);

    await waitFor(() => aliceNotifs.length === 1);
    const notif = aliceNotifs[0];
    assert.strictEqual(notif.type, 'push-notification');
    if (notif.type === 'push-notification') {
      assert.strictEqual(notif.pushId, 'push-id-3');
      assert.strictEqual(notif.branch, 'main');
      assert.strictEqual(notif.files.length, 1);
    }

    await alice.close();
  });

  // -------------------- broadcastRevert --------------------

  test("broadcastRevert appends kind:'system' subKind:'revert' ChatRecord and broadcasts envelope", async () => {
    const alice = await connectClient(port, 'Alice');
    const aliceChat: ChatMessage[] = [];
    alice.onMessage((m) => { if (m.type === 'chat-message') { aliceChat.push(m); } });

    const files: PushFileEntry[] = [
      { relativePath: 'src/a.ts', status: 'modified', addedLines: 0, removedLines: 0 },
      { relativePath: 'src/b.ts', status: 'modified', addedLines: 0, removedLines: 0 },
      { relativePath: 'src/c.ts', status: 'modified', addedLines: 0, removedLines: 0 },
    ];
    const record: PushRecord = {
      id: 'push-id-4',
      memberId: 'host-id',
      memberDisplayName: HOST_NAME,
      message: '',
      branch: 'main',
      files,
      timestamp: Date.now(),
      reverted: true,
    };

    host.broadcastRevert(record);

    // Persisted record assertions
    await waitFor(() => chatLog.getRecords().length === 1);
    const r = chatLog.getRecords()[0];
    assert.strictEqual(r.kind, 'system');
    assert.strictEqual(r.subKind, 'revert');
    assert.strictEqual(r.body, `${HOST_NAME} reverted 3 file(s)`);
    assert.ok(r.meta);
    assert.strictEqual(r.meta.pushId, 'push-id-4');
    assert.strictEqual(r.meta.branch, 'main');
    assert.deepStrictEqual(r.meta.files, ['src/a.ts', 'src/b.ts', 'src/c.ts']);

    // Wire envelope assertions
    await waitFor(() => aliceChat.length === 1);
    const env = aliceChat[0];
    assert.strictEqual(env.kind, 'system');
    assert.strictEqual(env.subKind, 'revert');
    assert.strictEqual(env.body, `${HOST_NAME} reverted 3 file(s)`);

    await alice.close();
  });

  test('broadcastRevert still fires the original push-reverted wire envelope (Phase 3 contract)', async () => {
    const alice = await connectClient(port, 'Alice');
    const reverts: ProtocolMessage[] = [];
    alice.onMessage((m) => { if (m.type === 'push-reverted') { reverts.push(m); } });

    const record: PushRecord = {
      id: 'push-id-5',
      memberId: 'host-id',
      memberDisplayName: HOST_NAME,
      message: '',
      branch: 'main',
      files: [{ relativePath: 'foo.ts', status: 'modified', addedLines: 0, removedLines: 0 }],
      timestamp: Date.now(),
      reverted: true,
    };

    host.broadcastRevert(record);
    await waitFor(() => reverts.length === 1);
    const notif = reverts[0];
    assert.strictEqual(notif.type, 'push-reverted');
    if (notif.type === 'push-reverted') {
      assert.deepStrictEqual(notif.files, ['foo.ts']);
    }

    await alice.close();
  });

  // -------------------- broadcastBranchCreated --------------------

  test("broadcastBranchCreated appends kind:'system' subKind:'branch-created' ChatRecord and broadcasts envelope", async () => {
    const alice = await connectClient(port, 'Alice');
    const aliceChat: ChatMessage[] = [];
    alice.onMessage((m) => { if (m.type === 'chat-message') { aliceChat.push(m); } });

    const branch: BranchInfo = {
      name: 'fix-typo',
      createdBy: 'host-id',
      createdAt: Date.now(),
      locked: false,
    };

    host.broadcastBranchCreated(branch);

    // Persisted record assertions
    await waitFor(() => chatLog.getRecords().length === 1);
    const r = chatLog.getRecords()[0];
    assert.strictEqual(r.kind, 'system');
    assert.strictEqual(r.subKind, 'branch-created');
    assert.strictEqual(r.body, `${HOST_NAME} created branch 'fix-typo'`);
    assert.ok(r.meta);
    assert.strictEqual(r.meta.branch, 'fix-typo');
    // pushId / files absent for branch-created
    assert.strictEqual(r.meta.pushId, undefined);
    assert.strictEqual(r.meta.files, undefined);

    // Wire envelope assertions
    await waitFor(() => aliceChat.length === 1);
    const env = aliceChat[0];
    assert.strictEqual(env.kind, 'system');
    assert.strictEqual(env.subKind, 'branch-created');
    assert.strictEqual(env.body, `${HOST_NAME} created branch 'fix-typo'`);
    assert.ok(env.meta);
    assert.strictEqual(env.meta.branch, 'fix-typo');

    await alice.close();
  });

  test('broadcastBranchCreated still fires the original branch-created wire envelope (Phase 3 contract)', async () => {
    const alice = await connectClient(port, 'Alice');
    const events: ProtocolMessage[] = [];
    alice.onMessage((m) => { if (m.type === 'branch-created') { events.push(m); } });

    const branch: BranchInfo = {
      name: 'feature-y',
      createdBy: 'host-id',
      createdAt: Date.now(),
      locked: false,
    };
    host.broadcastBranchCreated(branch);

    await waitFor(() => events.length === 1);
    const notif = events[0];
    assert.strictEqual(notif.type, 'branch-created');
    if (notif.type === 'branch-created') {
      assert.strictEqual(notif.branch.name, 'feature-y');
    }

    await alice.close();
  });

  // -------------------- identity policy --------------------

  test("branch-created with unmapped createdBy: memberDisplayName falls back to hostDisplayName, memberId reflects branch.createdBy", async () => {
    // Plan 04-15 update: branch.createdBy is the actor's memberId. When it's
    // not in this.members (e.g. host-initiated creates pre-auth, or the
    // creator has disconnected), the displayName falls back to
    // hostDisplayName but the memberId still equals branch.createdBy — so
    // the persisted record faithfully records who claimed to create it.
    const branch: BranchInfo = { name: 'b1', createdBy: 'x', createdAt: 1, locked: false };
    host.broadcastBranchCreated(branch);

    await waitFor(() => chatLog.getRecords().length === 1);
    const r = chatLog.getRecords()[0];
    assert.strictEqual(
      r.memberId,
      'x',
      "memberId reflects branch.createdBy verbatim (Plan 04-15 CR-01-NEW)",
    );
    assert.strictEqual(
      r.memberDisplayName,
      HOST_NAME,
      'memberDisplayName falls back to hostDisplayName when createdBy not in members map',
    );
  });

  test("branch-created with mapped createdBy: memberDisplayName resolves via this.members map", async () => {
    // The first connecting client becomes the host (handleAuthRequest
    // assigns role:'host' and registers the member). Pass that authenticated
    // member's id as branch.createdBy; the helper must resolve it to the
    // member's displayName via this.members.
    const aliceHost = await connectClient(port, HOST_NAME);
    // Wait for the host to register the auth in this.members.
    await new Promise((r) => setTimeout(r, 50));

    const branch: BranchInfo = {
      name: 'b2',
      createdBy: aliceHost.memberId,
      createdAt: 1,
      locked: false,
    };
    host.broadcastBranchCreated(branch);

    await waitFor(() => chatLog.getRecords().length === 1);
    const r = chatLog.getRecords()[0];
    assert.strictEqual(
      r.memberId,
      aliceHost.memberId,
      'memberId equals branch.createdBy (the actor)',
    );
    assert.strictEqual(
      r.memberDisplayName,
      HOST_NAME,
      'displayName resolved via members map (this client connected as HOST_NAME)',
    );

    await aliceHost.close();
  });

  // -------------------- chat-log persistence failure tolerance --------------------

  test('chat-log persistence failure does NOT block the wire broadcast', async () => {
    // Replace the host's ChatLog with one whose append always rejects.
    // The original push-notification wire broadcast AND the chat-message
    // envelope must still reach connected clients.
    const failingLog = new ChatLog(path.join(tmpDir, 'branch-fail'));
    await failingLog.load();
    // Monkey-patch append to reject.
    (failingLog as unknown as { append: (r: ChatRecord) => Promise<void> }).append = (
      _r: ChatRecord,
    ) => Promise.reject(new Error('disk write failed (intentional test)'));
    host.setChatLog(failingLog, 'main');

    const alice = await connectClient(port, 'Alice');
    const pushNotifs: ProtocolMessage[] = [];
    const chatMessages: ChatMessage[] = [];
    alice.onMessage((m) => {
      if (m.type === 'push-notification') { pushNotifs.push(m); }
      if (m.type === 'chat-message') { chatMessages.push(m); }
    });

    const record: PushRecord = {
      id: 'push-id-fail-test',
      memberId: 'host-id',
      memberDisplayName: HOST_NAME,
      message: 'failed-disk',
      branch: 'main',
      files: [{ relativePath: 'q.ts', status: 'modified', addedLines: 1, removedLines: 0 }],
      timestamp: Date.now(),
      reverted: false,
    };

    host.broadcastPush(record);

    // Both wire broadcasts should reach alice even though the persistence
    // path is throwing.
    await waitFor(() => pushNotifs.length === 1 && chatMessages.length === 1);
    assert.strictEqual(pushNotifs[0].type, 'push-notification', 'Phase 3 wire broadcast still fires');
    assert.strictEqual(chatMessages[0].kind, 'system', 'system-event chat-message still fires');
    assert.strictEqual(chatMessages[0].body, `${HOST_NAME} pushed 1 file(s)`);

    await alice.close();
  });

  test('null chatLog is tolerated — broadcasts still fire when setChatLog has not been called', async () => {
    // Build a fresh host with no setChatLog call — exercises the chatLog===null
    // branch in appendAndBroadcastSystemEvent. Important because the host's
    // public API contract is "wire-up is optional" (Plan 04-04 graceful
    // degradation).
    const cfg: SessionConfig = {
      sessionName: 'Phase4SystemEventsNoLog',
      port: 0,
      networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD,
      inviteCode: INVITE,
    };
    const noLogHost = new SessionHost(cfg, HOST_NAME);
    const noLogPort = await noLogHost.start();
    try {
      const alice = await connectClient(noLogPort, 'Alice');
      const chatMessages: ChatMessage[] = [];
      alice.onMessage((m) => {
        if (m.type === 'chat-message') { chatMessages.push(m); }
      });

      const branch: BranchInfo = { name: 'b3', createdBy: 'x', createdAt: 1, locked: false };
      noLogHost.broadcastBranchCreated(branch);

      // chat-message envelope must still fire even with no chatLog.
      await waitFor(() => chatMessages.length === 1);
      assert.strictEqual(chatMessages[0].subKind, 'branch-created');
      assert.strictEqual(chatMessages[0].body, `${HOST_NAME} created branch 'b3'`);

      await alice.close();
    } finally {
      noLogHost.stop();
    }
  });

  // -------------------- coexistence with Plan 04-13 input validation --------------------

  test("CR-01 still coerces client-authored kind:'system' frames — host-internal system writes remain intact (04-12 vs 04-13)", async () => {
    // This regression test pins down the boundary established by Plan 04-13:
    //   • Client-authored chat-message frames with kind:'system' → COERCED to user (CR-01)
    //   • Host-internal broadcastPush/Revert/BranchCreated → kind:'system' PRESERVED
    // Both paths coexist in the same SessionHost instance simultaneously.

    const alice = await connectClient(port, 'Alice');
    const bob = await connectClient(port, 'Bob');
    const bobChat: ChatMessage[] = [];
    bob.onMessage((m) => { if (m.type === 'chat-message') { bobChat.push(m); } });

    // (1) Client tries to forge a system event — must be coerced to user.
    alice.send({
      type: 'chat-message',
      timestamp: 1,
      recordId: 'r-forge',
      kind: 'system',
      subKind: 'push',
      memberId: alice.memberId,
      memberDisplayName: 'Alice',
      body: 'fake push',
      meta: { pushId: 'fake', branch: 'main', files: ['x.ts'] },
    });

    // (2) Host emits a real system event — must remain kind:'system'.
    host.broadcastBranchCreated({ name: 'real-branch', createdBy: 'host-id', createdAt: 1, locked: false });

    // Wait until bob has both messages (order is best-effort but both must arrive).
    await waitFor(() => bobChat.length >= 2, 3000);

    const forged = bobChat.find((m) => m.recordId === 'r-forge');
    const real = bobChat.find((m) => m.subKind === 'branch-created');

    assert.ok(forged, 'forged frame still reached bob (just coerced)');
    assert.strictEqual(forged.kind, 'user', "forged kind:'system' coerced to 'user' (CR-01 from 04-13)");
    assert.strictEqual(forged.subKind, undefined, 'forged subKind stripped');

    assert.ok(real, 'real host-emitted system event reached bob');
    assert.strictEqual(real.kind, 'system', "host-internal kind:'system' preserved (04-12)");
    assert.strictEqual(real.subKind, 'branch-created');
    assert.strictEqual(real.body, `${HOST_NAME} created branch 'real-branch'`);

    await alice.close();
    await bob.close();
  });

  // -------------------- shared id between persisted record and wire envelope --------------------

  test('persisted ChatRecord.id matches the chat-message envelope.recordId (dedupe contract)', async () => {
    const alice = await connectClient(port, 'Alice');
    const aliceChat: ChatMessage[] = [];
    alice.onMessage((m) => { if (m.type === 'chat-message') { aliceChat.push(m); } });

    const branch: BranchInfo = { name: 'shared-id', createdBy: 'x', createdAt: 1, locked: false };
    host.broadcastBranchCreated(branch);

    await waitFor(() => chatLog.getRecords().length === 1 && aliceChat.length === 1);
    const persistedId = chatLog.getRecords()[0].id;
    const envelopeRecordId = aliceChat[0].recordId;
    assert.strictEqual(
      persistedId,
      envelopeRecordId,
      'shared id lets clients dedupe live system events against later chat-history replays',
    );

    await alice.close();
  });
});

// ---------------------------------------------------------------------------
// Phase 4 system event correctness (Plan 04-15 — CR-01-NEW / CR-02-NEW / CR-03-NEW)
//
// Closes three blockers introduced by 04-12 and 04-13:
//   - CR-01-NEW: actor displayName misattributed to host on push/revert/branch
//   - CR-02-NEW: host's own ChatPanel desyncs from chat-log.json (no self-echo)
//   - CR-03-NEW: path validator over-rejects legitimate '..'-bearing filenames
//
// Reuses connectClient / waitFor module-scope helpers and the same
// boot/connect harness as the existing 'Phase 4 system events in chat' suite.
// ---------------------------------------------------------------------------

suite('Phase 4 system event correctness', () => {
  let host: SessionHost;
  let chatLog: ChatLog;
  let tmpDir: string;
  let port: number;

  setup(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `vc-host-system-correctness-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const branchDir = path.join(tmpDir, 'branch');
    await fs.mkdir(branchDir, { recursive: true });
    chatLog = new ChatLog(branchDir);
    await chatLog.load();

    const config: SessionConfig = {
      sessionName: 'Phase4SystemCorrectness',
      port: 0,
      networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD,
      inviteCode: INVITE,
    };
    host = new SessionHost(config, HOST_NAME);
    host.setChatLog(chatLog, 'main');
    port = await host.start();
  });

  teardown(async () => {
    try { host.stop(); } catch { /* best-effort */ }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ---------------- CR-01-NEW (actor displayName) ----------------

  test('CR-01-NEW: broadcastPush body and stamped identity use record.memberDisplayName, not host name', async () => {
    const alice = await connectClient(port, 'Alice');
    const aliceChat: ChatMessage[] = [];
    alice.onMessage((m) => { if (m.type === 'chat-message') { aliceChat.push(m); } });

    const pushRecord: PushRecord = {
      id: 'p1',
      memberId: 'mem-bob',
      memberDisplayName: 'Bob',
      message: 'fix',
      branch: 'main',
      files: [
        { relativePath: 'src/foo.ts', status: 'modified', addedLines: 1, removedLines: 0 },
      ],
      timestamp: Date.now(),
      reverted: false,
    };

    const returned = host.broadcastPush(pushRecord);

    // Returned record assertions
    assert.ok(returned, 'broadcastPush returns a ChatRecord');
    assert.strictEqual(returned.body, 'Bob pushed 1 file(s)', 'body uses record.memberDisplayName');
    assert.strictEqual(returned.memberDisplayName, 'Bob', 'stamped memberDisplayName = record.memberDisplayName');
    assert.strictEqual(returned.memberId, 'mem-bob', 'stamped memberId = record.memberId');
    assert.ok(!returned.body.includes(HOST_NAME), 'body does NOT contain host name');

    // Wire envelope assertions
    await waitFor(() => aliceChat.length === 1);
    const env = aliceChat[0];
    assert.strictEqual(env.body, 'Bob pushed 1 file(s)');
    assert.strictEqual(env.memberDisplayName, 'Bob');
    assert.strictEqual(env.memberId, 'mem-bob');
    assert.ok(!env.body.includes(HOST_NAME));

    await alice.close();
  });

  test('CR-01-NEW: broadcastRevert body and stamped identity use record.memberDisplayName', async () => {
    const alice = await connectClient(port, 'Alice');
    const aliceChat: ChatMessage[] = [];
    alice.onMessage((m) => { if (m.type === 'chat-message') { aliceChat.push(m); } });

    const pushRecord: PushRecord = {
      id: 'p1',
      memberId: 'mem-bob',
      memberDisplayName: 'Bob',
      message: 'fix',
      branch: 'main',
      files: [
        { relativePath: 'src/foo.ts', status: 'modified', addedLines: 1, removedLines: 0 },
      ],
      timestamp: Date.now(),
      reverted: true,
    };

    const returned = host.broadcastRevert(pushRecord);

    assert.ok(returned, 'broadcastRevert returns a ChatRecord');
    assert.strictEqual(returned.body, 'Bob reverted 1 file(s)');
    assert.strictEqual(returned.memberDisplayName, 'Bob');
    assert.strictEqual(returned.memberId, 'mem-bob');
    assert.ok(!returned.body.includes(HOST_NAME));

    await waitFor(() => aliceChat.length === 1);
    const env = aliceChat[0];
    assert.strictEqual(env.body, 'Bob reverted 1 file(s)');
    assert.strictEqual(env.memberDisplayName, 'Bob');
    assert.strictEqual(env.memberId, 'mem-bob');
    assert.ok(!env.body.includes(HOST_NAME));

    await alice.close();
  });

  test('CR-01-NEW: broadcastBranchCreated resolves branch.createdBy via members map (with hostDisplayName fallback)', async () => {
    // Connect Bob so this.members has an entry mapping bob.memberId → 'Bob'.
    const bob = await connectClient(port, 'Bob');
    // Wait for the host to register bob in this.members (auth-success → addMember).
    await waitFor(() => host.getPresenceSnapshot !== undefined);
    await new Promise((r) => setTimeout(r, 50));

    // (1) Resolved-via-members path
    const branchByBob: BranchInfo = {
      name: 'feature-x',
      createdBy: bob.memberId,
      createdAt: Date.now(),
      locked: false,
    };
    const resolved = host.broadcastBranchCreated(branchByBob);
    assert.strictEqual(
      resolved.body,
      "Bob created branch 'feature-x'",
      'body uses displayName resolved from members map',
    );
    assert.strictEqual(resolved.memberId, bob.memberId, 'stamped memberId = branch.createdBy');
    assert.strictEqual(resolved.memberDisplayName, 'Bob', 'stamped displayName from members map');

    // (2) Fallback path — createdBy not in this.members
    const branchByGhost: BranchInfo = {
      name: 'ghost-branch',
      createdBy: 'unknown-mem',
      createdAt: Date.now(),
      locked: false,
    };
    const fallback = host.broadcastBranchCreated(branchByGhost);
    assert.strictEqual(
      fallback.memberDisplayName,
      HOST_NAME,
      'unmapped createdBy falls back to hostDisplayName (host-initiated path)',
    );
    assert.strictEqual(
      fallback.body,
      `${HOST_NAME} created branch 'ghost-branch'`,
      'body uses hostDisplayName fallback',
    );
    assert.strictEqual(fallback.memberId, 'unknown-mem', 'stamped memberId still equals branch.createdBy');

    await bob.close();
  });

  // ---------------- CR-02-NEW (host-self echo: return-and-wire-id contract) ----------------

  test('CR-02-NEW: broadcastPush/Revert/BranchCreated return ChatRecord whose id matches the wire envelope.recordId', async () => {
    const alice = await connectClient(port, 'Alice');
    const aliceChat: ChatMessage[] = [];
    alice.onMessage((m) => { if (m.type === 'chat-message') { aliceChat.push(m); } });

    const pushRecord: PushRecord = {
      id: 'p-echo',
      memberId: 'mem-bob',
      memberDisplayName: 'Bob',
      message: 'm',
      branch: 'main',
      files: [{ relativePath: 'a.ts', status: 'modified', addedLines: 1, removedLines: 0 }],
      timestamp: Date.now(),
      reverted: false,
    };
    const branchInfo: BranchInfo = {
      name: 'echo-branch',
      createdBy: 'mem-bob',
      createdAt: Date.now(),
      locked: false,
    };

    // (1) broadcastPush
    const pushReturned = host.broadcastPush(pushRecord);
    assert.ok(pushReturned, 'broadcastPush returns a non-undefined ChatRecord');
    assert.strictEqual(typeof pushReturned.id, 'string');
    assert.ok(pushReturned.id.length > 0, 'id is a non-empty string');
    assert.strictEqual(pushReturned.kind, 'system');
    assert.strictEqual(pushReturned.subKind, 'push');
    await waitFor(() => aliceChat.find((m) => m.subKind === 'push') !== undefined);
    const pushEnv = aliceChat.find((m) => m.subKind === 'push');
    assert.ok(pushEnv);
    assert.strictEqual(pushEnv.recordId, pushReturned.id, 'wire envelope recordId matches returned id');

    // (2) broadcastRevert
    const revertReturned = host.broadcastRevert(pushRecord);
    assert.ok(revertReturned);
    assert.strictEqual(revertReturned.kind, 'system');
    assert.strictEqual(revertReturned.subKind, 'revert');
    await waitFor(() => aliceChat.find((m) => m.subKind === 'revert') !== undefined);
    const revertEnv = aliceChat.find((m) => m.subKind === 'revert');
    assert.ok(revertEnv);
    assert.strictEqual(revertEnv.recordId, revertReturned.id);

    // (3) broadcastBranchCreated
    const branchReturned = host.broadcastBranchCreated(branchInfo);
    assert.ok(branchReturned);
    assert.strictEqual(branchReturned.kind, 'system');
    assert.strictEqual(branchReturned.subKind, 'branch-created');
    await waitFor(() => aliceChat.find((m) => m.subKind === 'branch-created') !== undefined);
    const branchEnv = aliceChat.find((m) => m.subKind === 'branch-created');
    assert.ok(branchEnv);
    assert.strictEqual(branchEnv.recordId, branchReturned.id);

    // (4) chat-log persistence: all three returned ids appear in the persisted log,
    //     proving caller-side echo (extension.ts dispatchChatReceivedLocally) shares
    //     the same id used for the wire envelope and the persisted record — so
    //     client-side dedupe + caller-side echo work without duplication.
    await waitFor(() => chatLog.getRecords().length === 3);
    const persistedIds = chatLog.getRecords().map((r) => r.id);
    assert.ok(persistedIds.includes(pushReturned.id), 'push record persisted with same id');
    assert.ok(persistedIds.includes(revertReturned.id), 'revert record persisted with same id');
    assert.ok(persistedIds.includes(branchReturned.id), 'branch-created record persisted with same id');

    await alice.close();
  });

  // ---------------- CR-03-NEW (segment-aware path validator) ----------------

  test('CR-03-NEW: presence-update accepts legitimate filenames containing two consecutive periods', async () => {
    const alice = await connectClient(port, 'Alice');
    const bob = await connectClient(port, 'Bob');
    const aliceReceived: PresenceUpdate[] = [];
    alice.onMessage((m) => { if (m.type === 'presence-update') { aliceReceived.push(m); } });

    const acceptedPaths = ['src/foo..bar.ts', 'package..json', 'my..folder/index.ts'];

    for (const path of acceptedPaths) {
      bob.send({
        type: 'presence-update',
        timestamp: 1,
        memberId: bob.memberId,
        displayName: 'Bob',
        branch: 'main',
        activeFilePath: path,
      });
    }

    // All three frames should reach Alice with the activeFilePath verbatim.
    await waitFor(() => aliceReceived.length === acceptedPaths.length, 3000);
    const observedPaths = aliceReceived.map((m) => m.activeFilePath);
    for (const p of acceptedPaths) {
      assert.ok(
        observedPaths.includes(p),
        `Alice received a presence-update with activeFilePath=${p} (verbatim, no rejection)`,
      );
    }

    // Host's own presence map must store the verbatim final path (last write wins per memberId).
    const snapshot = host.getPresenceSnapshot();
    const bobEntry = snapshot.find((e: PresenceInfo) => e.memberId === bob.memberId);
    assert.ok(bobEntry, 'bob present in host snapshot');
    assert.strictEqual(
      bobEntry.activeFilePath,
      acceptedPaths[acceptedPaths.length - 1],
      'host PresenceMap stores the most recent legitimate `..`-bearing path verbatim',
    );

    await alice.close();
    await bob.close();
  });

  test('CR-03-NEW: presence-update still rejects directory-traversal segments (negative regression)', async () => {
    const alice = await connectClient(port, 'Alice');
    const bob = await connectClient(port, 'Bob');
    const aliceReceived: PresenceUpdate[] = [];
    alice.onMessage((m) => { if (m.type === 'presence-update') { aliceReceived.push(m); } });

    const rejectedPaths = ['../../etc/passwd', 'src/../../etc/passwd'];

    for (const path of rejectedPaths) {
      bob.send({
        type: 'presence-update',
        timestamp: 1,
        memberId: bob.memberId,
        displayName: 'Bob',
        branch: 'main',
        activeFilePath: path,
      });
    }

    // Allow time for the host to (silently) drop the frames.
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(
      aliceReceived.length,
      0,
      'host silently dropped both directory-traversal vectors — Alice received NO presence-update',
    );

    // Sanity: a follow-up legitimate path STILL works (proves the host did not crash
    // and the rejection branch returned cleanly).
    bob.send({
      type: 'presence-update',
      timestamp: 1,
      memberId: bob.memberId,
      displayName: 'Bob',
      branch: 'main',
      activeFilePath: 'src/foo.ts',
    });
    await waitFor(() => aliceReceived.length === 1);
    assert.strictEqual(aliceReceived[0].activeFilePath, 'src/foo.ts');

    await alice.close();
    await bob.close();
  });
});
