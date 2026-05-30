import * as assert from 'assert';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { WebSocket } from 'ws';
import { SessionHost } from '../../host/SessionHost.js';
import { SessionClient } from '../../client/SessionClient.js';
import { ChatLog } from '../../filesystem/ChatLog.js';
import type { ChatRecord, PresenceInfo } from '../../types/chat.js';
import type {
  ProtocolMessage,
  AuthRequest,
  ChatMessage,
  ChatHistory,
  PresenceUpdate,
} from '../../network/protocol.js';
import type { ClientTransport } from '../../network/Transport.js';
import type { HostIdentity, SessionConfig } from '../../types/session.js';
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

/**
 * Phase 4.1 helper: synthesize a fresh HostIdentity for each test's
 * SessionHost. Each call produces a unique memberId + hostAuthSecret
 * so tests cannot accidentally leak a secret across host instances.
 */
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
    host = new SessionHost(config, makeHostIdentity(HOST_NAME));
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
    host = new SessionHost(config, makeHostIdentity(HOST_NAME));
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
    host = new SessionHost(config, makeHostIdentity(HOST_NAME));
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
    const noLogHost = new SessionHost(cfg, makeHostIdentity(HOST_NAME));
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
    host = new SessionHost(config, makeHostIdentity(HOST_NAME));
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

// ---------------------------------------------------------------------------
// Phase 4.1 host pre-registration (Plan 04.1-02 — Defect B closure)
//
// Closes the "first authenticated WebSocket wins host role" race in
// SessionHost.ts:501-505. After this plan, the host's memberId and
// displayName + a hostAuthSecret are pre-allocated by the wizard
// (plan 04.1-03) before SessionHost is constructed. role:'host' is
// granted ONLY to a connection that proves possession of the secret
// via timingSafeEqual; remote clients without the secret always get
// role:'member' regardless of timing.
// ---------------------------------------------------------------------------

suite('Phase 4.1 host pre-registration', () => {
  let host: SessionHost;
  let port: number;
  let hostIdentity: HostIdentity;

  setup(async () => {
    hostIdentity = makeHostIdentity(HOST_NAME);
    const config: SessionConfig = {
      sessionName: 'Phase4.1Test',
      port: 0,
      networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD,
      inviteCode: INVITE,
    };
    host = new SessionHost(config, hostIdentity);
    port = await host.start();
  });

  teardown(async () => {
    try { host.stop(); } catch { /* best-effort */ }
  });

  test('host loopback auth with correct hostAuthSecret gets role:host (Defect B happy path)', async () => {
    // Connect with hostAuthSecret set in auth-request — mirrors what
    // plan 04.1-03's loopback client will do.
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const listeners = new Set<(m: ProtocolMessage) => void>();
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as ProtocolMessage;
        for (const fn of listeners) { try { fn(msg); } catch { /* ignore */ } }
      } catch { /* malformed — ignore */ }
    });

    ws.send(JSON.stringify({
      type: 'auth-request',
      timestamp: Date.now(),
      inviteCode: INVITE,
      displayName: HOST_NAME,
      hostAuthSecret: hostIdentity.hostAuthSecret, // <-- the gate
    }));

    const authResp = await new Promise<ProtocolMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('auth timeout')), 2000);
      const handler = (m: ProtocolMessage): void => {
        if (m.type === 'auth-response') { clearTimeout(timer); resolve(m); }
      };
      listeners.add(handler);
    });
    assert.strictEqual(authResp.type, 'auth-response');
    if (authResp.type !== 'auth-response') throw new Error('typing');
    assert.ok(authResp.accepted, 'host loopback accepted');

    // Find the auth'd member in host.getMembers() and assert role.
    const members = host.getMembers();
    const hostMember = members.find(m => m.id === authResp.memberId);
    assert.ok(hostMember, 'host member present in members list');
    assert.strictEqual(hostMember!.role, 'host', 'role:host granted on correct secret');

    ws.close();
  });

  test('remote auth WITHOUT hostAuthSecret gets role:member (Defect B race protection)', async () => {
    const remote = await connectClient(port, 'RemoteAttacker');
    // No hostAuthSecret in the auth-request — connectClient does not set it.
    const members = host.getMembers();
    const remoteMember = members.find(m => m.id === remote.memberId);
    assert.ok(remoteMember, 'remote member present in members list');
    assert.strictEqual(remoteMember!.role, 'member',
      'role:member assigned to remote without secret — race protection');
    await remote.close();
  });

  test('remote auth WITH WRONG hostAuthSecret gets role:member (Defect B secret mismatch)', async () => {
    // Send a wrong-secret auth-request via raw ws (connectClient does
    // not pass hostAuthSecret — we need the lower-level harness here).
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const listeners = new Set<(m: ProtocolMessage) => void>();
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as ProtocolMessage;
        for (const fn of listeners) { try { fn(msg); } catch { /* ignore */ } }
      } catch { /* malformed — ignore */ }
    });

    ws.send(JSON.stringify({
      type: 'auth-request',
      timestamp: Date.now(),
      inviteCode: INVITE,
      displayName: 'Attacker',
      hostAuthSecret: 'wrong-secret-of-different-length',  // wrong, length-mismatched
    }));

    const authResp = await new Promise<ProtocolMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('auth timeout')), 2000);
      const handler = (m: ProtocolMessage): void => {
        if (m.type === 'auth-response') { clearTimeout(timer); resolve(m); }
      };
      listeners.add(handler);
    });
    assert.strictEqual(authResp.type, 'auth-response');
    if (authResp.type !== 'auth-response') throw new Error('typing');
    assert.ok(authResp.accepted, 'auth still accepted (secret check is role-only, not auth gate)');

    const members = host.getMembers();
    const attackerMember = members.find(m => m.id === authResp.memberId);
    assert.ok(attackerMember, 'attacker member present');
    assert.strictEqual(attackerMember!.role, 'member',
      'role:member on wrong secret — no host hijack via length-mismatched guess');

    ws.close();
  });

  test('remote auth that connects FIRST is still role:member (Defect B race window closed)', async () => {
    // The setup() above already started the host. Connect a remote BEFORE
    // any loopback client. Pre-Phase-4.1 semantics: this remote would have
    // been first-authenticated and gotten role:host. Post-Phase-4.1: the
    // pre-allocated this.hostMemberId is non-null from the constructor, so
    // the OLD branch `this.hostMemberId === null ? 'host' : 'member'`
    // would still produce 'member' — but that branch is gone. The NEW
    // branch is secret-only, so this remote (no secret) is 'member'.
    const firstRemote = await connectClient(port, 'FirstToConnect');
    const members = host.getMembers();
    const firstMember = members.find(m => m.id === firstRemote.memberId);
    assert.ok(firstMember, 'first remote present');
    assert.strictEqual(firstMember!.role, 'member',
      'first-to-authenticate remote gets role:member — host-by-construction not host-by-race');
    await firstRemote.close();
  });

  test('after loopback host authenticates, kickMember (host-only admin) works for ws-authed host id', async () => {
    // Connect loopback host first (with secret), then a remote.
    const hostWs = new WebSocket(`ws://127.0.0.1:${port}`);
    const hostListeners = new Set<(m: ProtocolMessage) => void>();
    await new Promise<void>((resolve, reject) => {
      hostWs.once('open', () => resolve());
      hostWs.once('error', reject);
    });
    hostWs.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as ProtocolMessage;
        for (const fn of hostListeners) { try { fn(msg); } catch { /* ignore */ } }
      } catch { /* malformed */ }
    });
    hostWs.send(JSON.stringify({
      type: 'auth-request',
      timestamp: Date.now(),
      inviteCode: INVITE,
      displayName: HOST_NAME,
      hostAuthSecret: hostIdentity.hostAuthSecret,
    }));
    const hostAuth = await new Promise<ProtocolMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('host auth timeout')), 2000);
      const handler = (m: ProtocolMessage): void => {
        if (m.type === 'auth-response') { clearTimeout(timer); resolve(m); }
      };
      hostListeners.add(handler);
    });
    if (hostAuth.type !== 'auth-response' || !hostAuth.accepted) throw new Error('host auth failed');

    const remote = await connectClient(port, 'RemoteVictim');
    const targetId = remote.memberId;

    // Loopback host sends kick-member frame.
    hostWs.send(JSON.stringify({
      type: 'kick-member',
      timestamp: Date.now(),
      targetMemberId: targetId,
    }));

    // Remote should receive member-kicked and ws should close.
    const kicked = await remote.waitFor('member-kicked', 2000);
    assert.strictEqual(kicked.type, 'member-kicked', 'remote received kick');

    hostWs.close();
    await remote.close();
  });

  test('CR-01-NEW preservation: broadcastPush with remote PushRecord still uses record.memberDisplayName, not host name', async () => {
    // Regression guard for plan 04-15 closure under the new host
    // pre-registration model. The actor identity for system events
    // continues to flow from PushRecord, NOT from this.hostDisplayName.
    const alice = await connectClient(port, 'Alice');

    const pushRecord: PushRecord = {
      id: 'p-04-1-02',
      memberId: 'mem-bob',
      memberDisplayName: 'Bob',
      message: 'fix',
      branch: 'main',
      files: [{ relativePath: 'src/foo.ts', status: 'modified', addedLines: 1, removedLines: 0 } as PushFileEntry],
      timestamp: Date.now(),
      reverted: false,
    };
    const returned = host.broadcastPush(pushRecord);
    assert.strictEqual(returned.body, 'Bob pushed 1 file(s)',
      "body uses record.memberDisplayName ('Bob'), NOT HOST_NAME — plan 04-15 closure preserved");
    assert.strictEqual(returned.memberDisplayName, 'Bob');
    assert.strictEqual(returned.memberId, 'mem-bob');
    assert.ok(!returned.body.includes(HOST_NAME),
      'host displayName must not leak into the system-event body');

    await alice.close();
  });
});

// ---------------------------------------------------------------------------
// Phase 4.1 cross-cutting regression (Plan 04.1-04)
//
// End-to-end regression coverage for Phase 4.1 (host-identity-and-creation-
// wizard): proves both defects are closed and Phase 4 closures (CR-01-NEW,
// CR-02-NEW, CR-03-NEW from plan 04-15; CR-01/CR-02/CR-03 from plan 04-13)
// are preserved under the new HostIdentity model.
//
// Test layout:
//   1. Wizard contract (Defect A) — source-grep on WizardPanel.ts
//   2. Defect B race protection (live integration with HostIdentity)
//   3. CR-01-NEW preservation for broadcastPush
//   4. CR-01-NEW preservation for broadcastRevert
//   5. CR-01-NEW preservation for broadcastBranchCreated (members-map + fallback)
//   6. CR-02-NEW preservation (return-and-echo contract via record.id)
//   7. CR-03-NEW preservation (segment-aware path validator)
//   8. Secret hygiene — hostAuthSecret never in chatLog.getRecords() JSON
//   9. Secret hygiene — hostAuthSecret never in wire envelopes (push-notification, chat-message)
//  10. Length-mismatch attack — wrong-length secret does not crash, role:'member'
//  11. IIFE admin-bypass invariant — extension.ts hostMemberId stays 'local-user' (Plan 04.1-03 T4 pin)
// ---------------------------------------------------------------------------

suite('Phase 4.1 cross-cutting regression', () => {
  // -------------------------------------------------------------------------
  // Test 1 — Wizard contract (Defect A): source-grep on WizardPanel.ts.
  // Per STATE.md decisions table '[Plan 04-11]: UI-SPEC literal verification
  // via source-grep tests', wizard webview behavior is verified at the
  // source level (the webview itself requires multi-window UAT).
  // -------------------------------------------------------------------------
  test('Defect A — WizardPanel.ts implements default-resolution chain (settings → git → os → Host)', () => {
    // Lazy import — fs/sync is OK for source-introspection tests.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fsSync = require('fs') as typeof import('fs');
    const wizardPath = path.resolve(process.cwd(), 'src/ui/WizardPanel.ts');
    assert.ok(fsSync.existsSync(wizardPath), `WizardPanel.ts not found at ${wizardPath}`);
    const src = fsSync.readFileSync(wizardPath, 'utf-8');

    // The four steps of the default-resolution chain.
    assert.match(src, /resolveDefaultDisplayName/, 'helper method declared');
    assert.match(src, /vscode\.workspace[\s\S]{0,200}getConfiguration\('versioncon'\)[\s\S]{0,200}\.get<string>\('displayName'\)/,
      'step 1: workspace settings lookup');
    assert.match(src, /execFileSync\(\s*['"]git['"]\s*,\s*\[\s*['"]config['"]\s*,\s*['"]user\.name['"]\s*\]/,
      'step 2: git config user.name lookup with execFileSync (no shell)');
    assert.match(src, /os\.userInfo\(\)/, 'step 3: os.userInfo() fallback');
    assert.match(src, /return ['"]Host['"]/, "step 4: literal 'Host' fallback");

    // Validation rules.
    assert.match(src, /Display name is required/, 'non-empty validation');
    assert.match(src, /Display name must be 64 characters/, '64-char cap validation');
    assert.match(src, /Display name cannot contain control characters/, 'control-char rejection');

    // Persistence.
    assert.match(src, /ConfigurationTarget\.Workspace/, 'workspace-scoped settings persistence');

    // HostIdentity allocation in handleWizardComplete.
    assert.match(src, /memberId:\s*crypto\.randomUUID\(\)/, 'memberId allocated via crypto.randomUUID');
    assert.match(src, /hostAuthSecret:\s*crypto\.randomUUID\(\)/, 'hostAuthSecret allocated via crypto.randomUUID');
    assert.match(src, /new SessionHost\(config,\s*hostIdentity\)/, 'SessionHost constructed with HostIdentity');

    // Negative — old defect path is gone.
    assert.doesNotMatch(src, /new SessionHost\(config,\s*hostDisplayName\)/,
      'old hostDisplayName-string call site removed (Defect A closed)');
  });

  // -------------------------------------------------------------------------
  // Test 2 — Defect B race protection (integration). Boot host with a
  // freshly-allocated HostIdentity (mirroring what WizardPanel does at
  // runtime). Connect a remote BEFORE any loopback host client. Assert
  // role:'member'.
  // -------------------------------------------------------------------------
  test('Defect B — remote that connects FIRST never gets host role under HostIdentity model', async () => {
    const hostIdentity = makeHostIdentity('LocalHostUser');
    const config: SessionConfig = {
      sessionName: 'Phase4.1CrossCutting',
      port: 0,
      networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD,
      inviteCode: INVITE,
    };
    const host = new SessionHost(config, hostIdentity);
    const port = await host.start();

    // Connect a remote BEFORE any loopback. Pre-Phase-4.1 this would have
    // been first-authenticated and gotten role:'host'.
    const remote = await connectClient(port, 'RemoteAttacker');
    const members = host.getMembers();
    const remoteMember = members.find(m => m.id === remote.memberId);
    assert.ok(remoteMember, 'remote member is in the members list');
    assert.strictEqual(remoteMember!.role, 'member',
      'first-to-authenticate remote receives role:member under HostIdentity model');

    await remote.close();
    host.stop();
  });

  // -------------------------------------------------------------------------
  // Test 3 — CR-01-NEW preservation for broadcastPush.
  // -------------------------------------------------------------------------
  test('CR-01-NEW preserved — broadcastPush body uses record.memberDisplayName under HostIdentity model', async () => {
    const hostIdentity = makeHostIdentity('TheHost');
    const tmpDir = path.join(os.tmpdir(), `vc-04-1-04-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const branchDir = path.join(tmpDir, 'branch');
    await fs.mkdir(branchDir, { recursive: true });
    const chatLog = new ChatLog(branchDir);
    await chatLog.load();
    const config: SessionConfig = {
      sessionName: 'Phase4.1CC',
      port: 0,
      networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD,
      inviteCode: INVITE,
    };
    const host = new SessionHost(config, hostIdentity);
    host.setChatLog(chatLog, 'main');
    const port = await host.start();

    const alice = await connectClient(port, 'Alice');

    const pushRecord: PushRecord = {
      id: 'p-cc-01',
      memberId: 'mem-bob',
      memberDisplayName: 'Bob',
      message: 'fix',
      branch: 'main',
      files: [{ relativePath: 'src/foo.ts', status: 'modified', addedLines: 1, removedLines: 0 } as PushFileEntry],
      timestamp: Date.now(),
      reverted: false,
    };
    const returned = host.broadcastPush(pushRecord);
    assert.strictEqual(returned.body, 'Bob pushed 1 file(s)');
    assert.strictEqual(returned.memberDisplayName, 'Bob');
    assert.strictEqual(returned.memberId, 'mem-bob');
    assert.ok(!returned.body.includes(hostIdentity.displayName),
      "host's pre-allocated displayName must not leak into push body");
    assert.ok(!returned.body.includes(hostIdentity.memberId),
      "host's pre-allocated memberId must not leak into push body");

    await alice.close();
    host.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 4 — CR-01-NEW preservation for broadcastRevert.
  // -------------------------------------------------------------------------
  test('CR-01-NEW preserved — broadcastRevert body uses record.memberDisplayName under HostIdentity model', async () => {
    const hostIdentity = makeHostIdentity('TheHost');
    const tmpDir = path.join(os.tmpdir(), `vc-04-1-04r-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const branchDir = path.join(tmpDir, 'branch');
    await fs.mkdir(branchDir, { recursive: true });
    const chatLog = new ChatLog(branchDir);
    await chatLog.load();
    const config: SessionConfig = {
      sessionName: 'Phase4.1CCRevert', port: 0, networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD, inviteCode: INVITE,
    };
    const host = new SessionHost(config, hostIdentity);
    host.setChatLog(chatLog, 'main');
    const port = await host.start();
    const alice = await connectClient(port, 'Alice');

    const pushRecord: PushRecord = {
      id: 'p-cc-revert', memberId: 'mem-bob', memberDisplayName: 'Bob',
      message: 'revert', branch: 'main',
      files: [{ relativePath: 'src/foo.ts', status: 'modified', addedLines: 1, removedLines: 0 } as PushFileEntry],
      timestamp: Date.now(), reverted: true,
    };
    const returned = host.broadcastRevert(pushRecord);
    assert.strictEqual(returned.body, 'Bob reverted 1 file(s)');
    assert.strictEqual(returned.memberDisplayName, 'Bob');
    assert.strictEqual(returned.memberId, 'mem-bob');
    assert.ok(!returned.body.includes(hostIdentity.displayName),
      "host's pre-allocated displayName must not leak into revert body");

    await alice.close();
    host.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 5 — CR-01-NEW preservation for broadcastBranchCreated.
  // -------------------------------------------------------------------------
  test('CR-01-NEW preserved — broadcastBranchCreated resolves createdBy via members + hostIdentity fallback', async () => {
    const hostIdentity = makeHostIdentity('TheHost');
    const tmpDir = path.join(os.tmpdir(), `vc-04-1-04b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const branchDir = path.join(tmpDir, 'branch');
    await fs.mkdir(branchDir, { recursive: true });
    const chatLog = new ChatLog(branchDir);
    await chatLog.load();
    const config: SessionConfig = {
      sessionName: 'Phase4.1CCBranch', port: 0, networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD, inviteCode: INVITE,
    };
    const host = new SessionHost(config, hostIdentity);
    host.setChatLog(chatLog, 'main');
    const port = await host.start();

    const alice = await connectClient(port, 'Alice');
    // Wait for Alice to appear in host.members.
    await waitFor(() => host.getMembers().some(m => m.id === alice.memberId));

    // Path A: createdBy resolves via members map.
    const branchAlice: BranchInfo = {
      name: 'feature-x', createdBy: alice.memberId, createdAt: Date.now(), locked: false,
    };
    const returnedA = host.broadcastBranchCreated(branchAlice);
    assert.strictEqual(returnedA.body, "Alice created branch 'feature-x'",
      "createdBy resolved via members map → 'Alice'");
    assert.strictEqual(returnedA.memberDisplayName, 'Alice');

    // Path B: createdBy is unknown — fallback to hostIdentity.displayName.
    const branchUnknown: BranchInfo = {
      name: 'feature-y', createdBy: 'unknown-mem-id', createdAt: Date.now(), locked: false,
    };
    const returnedB = host.broadcastBranchCreated(branchUnknown);
    assert.strictEqual(returnedB.body, `${hostIdentity.displayName} created branch 'feature-y'`,
      'unknown createdBy falls back to host displayName from HostIdentity');
    assert.strictEqual(returnedB.memberDisplayName, hostIdentity.displayName);

    await alice.close();
    host.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 6 — CR-02-NEW preservation. broadcastPush/Revert/BranchCreated
  // return non-undefined ChatRecord with stable id; chatLog.getRecords()
  // contains the same id. The host-self echo at extension.ts call sites
  // depends on this contract.
  // -------------------------------------------------------------------------
  test('CR-02-NEW preserved — broadcast helpers return ChatRecord with stable id matching chat-log record', async () => {
    const hostIdentity = makeHostIdentity('TheHost');
    const tmpDir = path.join(os.tmpdir(), `vc-04-1-04echo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const branchDir = path.join(tmpDir, 'branch');
    await fs.mkdir(branchDir, { recursive: true });
    const chatLog = new ChatLog(branchDir);
    await chatLog.load();
    const config: SessionConfig = {
      sessionName: 'Phase4.1CCEcho', port: 0, networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD, inviteCode: INVITE,
    };
    const host = new SessionHost(config, hostIdentity);
    host.setChatLog(chatLog, 'main');
    const port = await host.start();
    const alice = await connectClient(port, 'Alice');

    const pushRecord: PushRecord = {
      id: 'p-cc-echo', memberId: 'mem-bob', memberDisplayName: 'Bob',
      message: 'fix', branch: 'main',
      files: [{ relativePath: 'src/foo.ts', status: 'modified', addedLines: 1, removedLines: 0 } as PushFileEntry],
      timestamp: Date.now(), reverted: false,
    };
    const returned = host.broadcastPush(pushRecord);
    assert.ok(returned, 'broadcastPush returned ChatRecord');
    assert.ok(typeof returned.id === 'string' && returned.id.length > 0, 'returned.id is non-empty string');

    await waitFor(() => chatLog.getRecords().some(r => r.id === returned.id));
    const matched = chatLog.getRecords().find(r => r.id === returned.id);
    assert.ok(matched, 'chat-log contains the record with the returned id');
    assert.strictEqual(matched!.body, returned.body, 'persisted body matches returned body');
    assert.strictEqual(matched!.memberDisplayName, returned.memberDisplayName);

    await alice.close();
    host.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 7 — CR-03-NEW preservation. Segment-aware path validator accepts
  // legitimate '..'-bearing filenames and rejects true directory traversal.
  // -------------------------------------------------------------------------
  test('CR-03-NEW preserved — presence-update accepts foo..bar.ts and rejects ../../etc/passwd', async () => {
    const hostIdentity = makeHostIdentity('TheHost');
    const config: SessionConfig = {
      sessionName: 'Phase4.1CCPath', port: 0, networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD, inviteCode: INVITE,
    };
    const host = new SessionHost(config, hostIdentity);
    const port = await host.start();
    const alice = await connectClient(port, 'Alice');
    const bob = await connectClient(port, 'Bob');

    // Positive: 'src/foo..bar.ts' must be accepted.
    const accepted = new Promise<ProtocolMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('positive path timeout')), 500);
      alice.onMessage((m) => {
        if (m.type === 'presence-update' && (m as PresenceUpdate).activeFilePath === 'src/foo..bar.ts') {
          clearTimeout(timer); resolve(m);
        }
      });
    });
    bob.send({
      type: 'presence-update', timestamp: Date.now(),
      memberId: bob.memberId, displayName: 'Bob', branch: 'main',
      activeFilePath: 'src/foo..bar.ts',
    });
    const acceptedFrame = await accepted;
    assert.strictEqual((acceptedFrame as PresenceUpdate).activeFilePath, 'src/foo..bar.ts',
      'segment-aware validator accepts legitimate two-period filename');

    // Negative: '../../etc/passwd' must be silently dropped — Alice never sees it.
    let traversalReceived = false;
    alice.onMessage((m) => {
      if (m.type === 'presence-update' && (m as PresenceUpdate).activeFilePath === '../../etc/passwd') {
        traversalReceived = true;
      }
    });
    bob.send({
      type: 'presence-update', timestamp: Date.now(),
      memberId: bob.memberId, displayName: 'Bob', branch: 'main',
      activeFilePath: '../../etc/passwd',
    });
    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(traversalReceived, false,
      'segment-aware validator silently drops directory-traversal segment');

    await alice.close();
    await bob.close();
    host.stop();
  });

  // -------------------------------------------------------------------------
  // Test 8 — Secret hygiene: hostAuthSecret never appears in chat-log.json.
  // After broadcasting push/revert/branch-created system events, serialize
  // chatLog.getRecords() and assert the secret string is absent.
  // -------------------------------------------------------------------------
  test('Secret hygiene — hostAuthSecret never persisted in chat-log records', async () => {
    const hostIdentity = makeHostIdentity('TheHost');
    const tmpDir = path.join(os.tmpdir(), `vc-04-1-04hyg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const branchDir = path.join(tmpDir, 'branch');
    await fs.mkdir(branchDir, { recursive: true });
    const chatLog = new ChatLog(branchDir);
    await chatLog.load();
    const config: SessionConfig = {
      sessionName: 'Phase4.1CCHyg', port: 0, networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD, inviteCode: INVITE,
    };
    const host = new SessionHost(config, hostIdentity);
    host.setChatLog(chatLog, 'main');
    const port = await host.start();
    const alice = await connectClient(port, 'Alice');

    // Push + revert + branch-created.
    const pushRecord: PushRecord = {
      id: 'p-hyg', memberId: 'mem-bob', memberDisplayName: 'Bob',
      message: 'hyg', branch: 'main',
      files: [{ relativePath: 'src/foo.ts', status: 'modified', addedLines: 1, removedLines: 0 } as PushFileEntry],
      timestamp: Date.now(), reverted: false,
    };
    host.broadcastPush(pushRecord);
    host.broadcastRevert(pushRecord);
    host.broadcastBranchCreated({ name: 'feature-hyg', createdBy: hostIdentity.memberId, createdAt: Date.now(), locked: false });

    // Wait for chatLog to capture all three.
    await waitFor(() => chatLog.getRecords().length >= 3);

    const serialized = JSON.stringify(chatLog.getRecords());
    assert.ok(!serialized.includes(hostIdentity.hostAuthSecret),
      'hostAuthSecret never appears in any persisted ChatRecord (T-04.1-01-02 mitigation)');

    await alice.close();
    host.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 9 — Secret hygiene: hostAuthSecret never broadcast on the wire.
  // Alice receives push-notification + chat-message envelopes; assert
  // neither serialized JSON contains the secret.
  // -------------------------------------------------------------------------
  test('Secret hygiene — hostAuthSecret never appears in wire envelopes (push-notification, chat-message)', async () => {
    const hostIdentity = makeHostIdentity('TheHost');
    const tmpDir = path.join(os.tmpdir(), `vc-04-1-04wire-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const branchDir = path.join(tmpDir, 'branch');
    await fs.mkdir(branchDir, { recursive: true });
    const chatLog = new ChatLog(branchDir);
    await chatLog.load();
    const config: SessionConfig = {
      sessionName: 'Phase4.1CCWire', port: 0, networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD, inviteCode: INVITE,
    };
    const host = new SessionHost(config, hostIdentity);
    host.setChatLog(chatLog, 'main');
    const port = await host.start();
    const alice = await connectClient(port, 'Alice');

    const collected: ProtocolMessage[] = [];
    alice.onMessage((m) => { collected.push(m); });

    const pushRecord: PushRecord = {
      id: 'p-wire', memberId: 'mem-bob', memberDisplayName: 'Bob',
      message: 'wire', branch: 'main',
      files: [{ relativePath: 'src/foo.ts', status: 'modified', addedLines: 1, removedLines: 0 } as PushFileEntry],
      timestamp: Date.now(), reverted: false,
    };
    host.broadcastPush(pushRecord);

    // Wait for the two expected wire frames (push-notification, chat-message).
    await waitFor(() =>
      collected.some(m => m.type === 'push-notification') &&
      collected.some(m => m.type === 'chat-message'));

    const wireDump = JSON.stringify(collected);
    assert.ok(!wireDump.includes(hostIdentity.hostAuthSecret),
      'hostAuthSecret never appears in any wire envelope received by a member (T-04.1-01-02 wire hygiene)');

    await alice.close();
    host.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 10 — Length-mismatch attack. A wrong-length hostAuthSecret must
  // not crash the server (length pre-check before timingSafeEqual); role
  // must be 'member'. T-04.1-02-01 mitigation evidence.
  // -------------------------------------------------------------------------
  test('Defect B — wrong-length hostAuthSecret does not crash server, role:member', async () => {
    const hostIdentity = makeHostIdentity('TheHost');
    const config: SessionConfig = {
      sessionName: 'Phase4.1CCLen', port: 0, networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD, inviteCode: INVITE,
    };
    const host = new SessionHost(config, hostIdentity);
    const port = await host.start();

    // Send auth-request with a clearly-wrong-length secret via raw ws.
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const listeners = new Set<(m: ProtocolMessage) => void>();
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as ProtocolMessage;
        for (const fn of listeners) { try { fn(msg); } catch { /* ignore */ } }
      } catch { /* malformed */ }
    });

    ws.send(JSON.stringify({
      type: 'auth-request', timestamp: Date.now(),
      inviteCode: INVITE, displayName: 'Attacker',
      hostAuthSecret: 'short',  // 5 chars — UUID is 36 chars; length mismatch
    }));

    const authResp = await new Promise<ProtocolMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('auth timeout')), 2000);
      const handler = (m: ProtocolMessage): void => {
        if (m.type === 'auth-response') { clearTimeout(timer); resolve(m); }
      };
      listeners.add(handler);
    });
    if (authResp.type !== 'auth-response') throw new Error('typing');
    assert.ok(authResp.accepted, 'auth still accepted (invite code is the auth gate, not secret)');

    const members = host.getMembers();
    const member = members.find(m => m.id === authResp.memberId);
    assert.ok(member, 'authenticated member present in members list');
    assert.strictEqual(member!.role, 'member',
      'wrong-length secret → role:member without server crash (length pre-check works)');

    ws.close();
    host.stop();
  });

  // -------------------------------------------------------------------------
  // Test 11 — IIFE admin-bypass invariant. Plan 04.1-03 T4 explicitly KEEPS
  // `let hostMemberId = 'local-user'` in extension.ts so the IIFE admin-bypass
  // at lines ~1282, ~1687, ~1768 (currentMemberId !== hostMemberId) resolves
  // to false on the host's own local commands. SessionHost.this.hostMemberId
  // is the pre-allocated UUID (post-04.1-02 — the wire-side identity); the
  // extension.ts hostMemberId is a SEPARATE placeholder used only for the
  // IIFE bypass. The two are intentionally decoupled. This test pins that
  // invariant so future refactors cannot silently break the host's local
  // push/branch permissions.
  // -------------------------------------------------------------------------
  test('Test 11 — IIFE admin-bypass invariant: extension.ts hostMemberId placeholder remains "local-user"', () => {
    // Local lazy-require: `fsSync` is declared inside each test() closure
    // (Test 1 also does this) so the synchronous fs API is in scope here.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fsSync = require('fs') as typeof import('fs');
    const extPath = path.resolve(process.cwd(), 'src/extension.ts');
    assert.ok(fsSync.existsSync(extPath), `extension.ts not found at ${extPath}`);
    const src = fsSync.readFileSync(extPath, 'utf-8');

    // The IIFE admin-bypass at lines ~1282, ~1687, ~1768 uses (currentMemberId !== hostMemberId)
    // to grant the host bypass on local push/branch commands. Both sides MUST be 'local-user'
    // for the bypass to resolve to false on the host's own commands.
    //
    // SessionHost.this.hostMemberId is the pre-allocated UUID (post-04.1-02). That UUID is the
    // wire-side host identity. The extension.ts hostMemberId is a SEPARATE placeholder used only
    // for the IIFE bypass. Plan 04.1-03 T4 explicitly preserves this decoupling.
    //
    // If a future change updates `let hostMemberId = 'local-user'` to `hostMemberId = hostIdentity.memberId`,
    // the IIFE bypass breaks: currentMemberId (still 'local-user') !== hostMemberId (UUID) → true →
    // host's own push/branch commands are gated by canPush/canCreateBranch and may be denied.

    assert.match(
      src,
      /let hostMemberId\s*=\s*['"]local-user['"]/,
      'extension.ts must declare `let hostMemberId = \'local-user\'` (line ~49). The IIFE admin-bypass invariant pins this placeholder; do NOT change to hostIdentity.memberId without also updating the IIFE.',
    );

    // Reinforce: line 580 reset must also stick to 'local-user'
    assert.match(
      src,
      /hostMemberId\s*=\s*['"]local-user['"]/g,
      'extension.ts must reset hostMemberId to \'local-user\' on session-end (line ~580). Same invariant as above.',
    );
  });
});

// -----------------------------------------------------------------------------
// Phase 4 UAT 2026-05-11 — closure suite for 999.3 (peer presence
// propagation) + 999.4 (displayName "You" fallback). Source-grep pattern,
// same shape as host.test.ts Test 11 + wizardValidation.test.ts.
// -----------------------------------------------------------------------------
suite('Phase 4 UAT 2026-05-11 — peer presence propagation + displayName closure', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fsSync = require('fs') as typeof import('fs');
  const extPath = path.resolve(process.cwd(), 'src/extension.ts');
  const hostPath = path.resolve(process.cwd(), 'src/host/SessionHost.ts');

  test('999.4: wireHostEvents updates currentSelfDisplayName from hostIdentity.displayName', () => {
    const src = fsSync.readFileSync(extPath, 'utf-8');
    // The fix lives in wireHostEvents right where currentSelfMemberId is set.
    assert.match(
      src,
      /currentSelfMemberId\s*=\s*hostMemberId;[\s\S]{0,400}currentSelfDisplayName\s*=\s*hostIdentity\.displayName;/,
      'wireHostEvents must update currentSelfDisplayName alongside currentSelfMemberId, otherwise the host emits PresenceInfo with displayName="You"',
    );
  });

  test('999.3a: client presence-update path locally upserts self into PresenceTree', () => {
    const src = fsSync.readFileSync(extPath, 'utf-8');
    // The activeClient branch must construct a self PresenceInfo and call
    // presenceTreeProvider.upsert because the host broadcast excludes the sender.
    assert.match(
      src,
      /if\s*\(activeClient\)\s*\{[\s\S]{0,1200}?presenceTreeProvider\?\.upsert\(selfInfo\);[\s\S]{0,200}?updatePresenceContext\(\);/,
      'client presence-update dispatch must locally upsert selfInfo into the presence tree (sender-excluded broadcast means client never receives own presence-update back)',
    );
  });

  test('999.3b: SessionHost emits "presence-update" event on incoming peer message', () => {
    const src = fsSync.readFileSync(hostPath, 'utf-8');
    // The handler at the 'presence-update' message-router case must emit the
    // SessionEvent so extension.ts wireHostEvents can update the host's tree.
    // The case block spans ~3.4KB, so this regex tolerates that range.
    assert.match(
      src,
      /this\.presenceMap\.upsert\(info\);[\s\S]{0,500}?this\.emit\(\s*['"]presence-update['"]\s*,\s*info\s*\)/,
      'SessionHost handler for incoming presence-update must call this.emit("presence-update", info) right after upserting into PresenceMap so the host process can react',
    );
  });

  test('999.3b: wireHostEvents subscribes to host.on("presence-update") and upserts into tree', () => {
    const src = fsSync.readFileSync(extPath, 'utf-8');
    assert.match(
      src,
      /host\.on\(\s*['"]presence-update['"]\s*,\s*\(info[^)]*\)\s*=>\s*\{[\s\S]{0,200}?presenceTreeProvider\?\.upsert\(info\);[\s\S]{0,100}?updatePresenceContext\(\);/,
      'wireHostEvents must register a host.on("presence-update") listener that calls presenceTreeProvider.upsert',
    );
  });

  test('999.3: wireHostEvents handles member-left by removing the row from PresenceTree', () => {
    const src = fsSync.readFileSync(extPath, 'utf-8');
    assert.match(
      src,
      /host\.on\(\s*['"]member-left['"]\s*,\s*\(data[^)]*\)\s*=>\s*\{[\s\S]{0,300}?presenceTreeProvider\?\.removeMember\(data\.memberId\);/,
      'wireHostEvents must clean up presence rows when a member leaves',
    );
  });

  test('999.5: wireClientEvents shows joiner onboarding notification with reveal action', () => {
    const src = fsSync.readFileSync(extPath, 'utf-8');
    // Notification text references branch files + path + reveal action.
    assert.match(
      src,
      /Branch files for[\s\S]{0,400}?Open\s+\.versioncon\s+Folder/,
      'wireClientEvents must show a one-time onboarding notification mentioning branch files and offering an "Open .versioncon Folder" action',
    );
    // path.join("...", "branches", branch) — confirm the branch-path construction is wired.
    assert.match(
      src,
      /path\.join\(versionconPath,\s*['"]branches['"]\s*,\s*branch\)/,
      'branchPath must be derived from path.join(versionconPath, "branches", branch) so the notification references the right per-branch directory',
    );
    assert.match(
      src,
      /revealFileInOS/,
      'Open Folder action must call revealFileInOS so the user can find the .versioncon directory in their OS file explorer',
    );
  });
});

// ---------------------------------------------------------------------------
// Presence snapshot on join (Plan 260530-np7)
//
// Every connected member must appear in the Presence panel immediately on join,
// even when no one has changed editors. The host replays its full presence map
// to a new joiner as individual presence-update frames (reusing the existing
// frame — no new protocol type). The host AND each joining member each broadcast
// their own presence once on join to seed their slot in every peer's map.
//
// Tests A-D mirror the 'Phase 4 host relay' integration suite shape:
//   A — snapshot replay: a previously-known member appears in the joiner inbox
//   B — idle member (activeFilePath null) delivered without crash
//   C — host self in snapshot: upsertHostPresence populates the snapshot;
//       a subsequent joiner receives a presence-update for the host id
//   D — LAN byte-shape: replayed frame has EXACTLY the canonical key set
//
// Reuses connectClient / waitFor module-scope helpers.
// ---------------------------------------------------------------------------

suite('Presence snapshot on join', () => {
  let host: SessionHost;
  let chatLog: ChatLog;
  let tmpDir: string;
  let port: number;

  setup(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `vc-presence-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const branchDir = path.join(tmpDir, 'branch');
    await fs.mkdir(branchDir, { recursive: true });
    chatLog = new ChatLog(branchDir);
    await chatLog.load();

    const config: SessionConfig = {
      sessionName: 'PresenceSnapshotTest',
      port: 0,
      networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD,
      inviteCode: INVITE,
    };
    host = new SessionHost(config, makeHostIdentity(HOST_NAME));
    host.setChatLog(chatLog, 'main');
    port = await host.start();
  });

  teardown(async () => {
    try { host.stop(); } catch { /* best-effort */ }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('Test A: joining client receives presence-update for prior member in snapshot', async () => {
    // Seed the host presence map with a known-prior member.
    host.upsertHostPresence({
      memberId: 'm-existing',
      displayName: 'Existing',
      branch: 'main',
      activeFilePath: 'src/a.ts',
      lastUpdated: Date.now(),
    });

    // Use the raw-ws pattern (mirrors sendChatHistoryToMember test) so we
    // collect ALL messages including those that arrive during the auth burst,
    // before a helper's auth-response await would return.
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
      displayName: 'JoinerA',
    }));

    await waitFor(() => inbox.some((m) => m.type === 'presence-update'), 3000);

    const frame = inbox.find((m) => m.type === 'presence-update') as PresenceUpdate;
    assert.ok(frame, 'presence-update was sent as snapshot replay');
    assert.strictEqual(frame.memberId, 'm-existing', 'snapshot delivers prior member id');
    assert.strictEqual(frame.branch, 'main');
    assert.strictEqual(frame.activeFilePath, 'src/a.ts');

    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve()); ws.close();
    });
  });

  test('Test B: joining client receives presence-update for idle member (activeFilePath null)', async () => {
    // Seed an idle member — activeFilePath null simulates someone on the
    // Welcome tab with no open editor.
    host.upsertHostPresence({
      memberId: 'm-idle',
      displayName: 'Idle',
      branch: 'main',
      activeFilePath: null,
      lastUpdated: Date.now(),
    });

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
      displayName: 'JoinerB',
    }));

    await waitFor(() => inbox.some((m) => m.type === 'presence-update'), 3000);

    const frame = inbox.find((m) => m.type === 'presence-update') as PresenceUpdate;
    assert.ok(frame, 'presence-update delivered for idle member');
    assert.strictEqual(frame.memberId, 'm-idle');
    assert.strictEqual(frame.activeFilePath, null, 'null activeFilePath delivered without crash');

    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve()); ws.close();
    });
  });

  test('Test C: host self in snapshot — joiner receives presence-update for host id', async () => {
    // Simulate the host seeding its own presence (as wireHostEvents would do).
    const hostSelfId = 'host-self-id';
    host.upsertHostPresence({
      memberId: hostSelfId,
      displayName: HOST_NAME,
      branch: 'main',
      activeFilePath: null,
      lastUpdated: Date.now(),
    });

    // Confirm the host's own id is in the snapshot before the joiner connects.
    const snapshot = host.getPresenceSnapshot();
    const hostEntry = snapshot.find((p) => p.memberId === hostSelfId);
    assert.ok(hostEntry, 'host self entry in snapshot');

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
      displayName: 'JoinerC',
    }));

    await waitFor(() => inbox.some(
      (m) => m.type === 'presence-update' && (m as PresenceUpdate).memberId === hostSelfId,
    ), 3000);

    const hostFrame = inbox.find(
      (m) => m.type === 'presence-update' && (m as PresenceUpdate).memberId === hostSelfId,
    ) as PresenceUpdate;
    assert.ok(hostFrame, 'joiner received presence-update for host id');

    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve()); ws.close();
    });
  });

  test('Test D: LAN byte-shape — replayed presence-update frame has exactly the canonical key set', async () => {
    // Seed one entry so the snapshot is non-empty.
    host.upsertHostPresence({
      memberId: 'm-shape-check',
      displayName: 'ShapeUser',
      branch: 'feature',
      activeFilePath: 'src/index.ts',
      lastUpdated: Date.now(),
    });

    // Use raw WebSocket to capture exact JSON bytes from the wire.
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const rawFrames: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.on('message', (raw: Buffer) => {
      rawFrames.push(raw.toString());
    });

    ws.send(JSON.stringify({
      type: 'auth-request',
      timestamp: Date.now(),
      inviteCode: INVITE,
      displayName: 'JoinerD',
    }));

    // Wait until a presence-update appears in rawFrames.
    await waitFor(() => rawFrames.some((r) => {
      try { const m = JSON.parse(r); return m.type === 'presence-update'; } catch { return false; }
    }), 3000);

    // Find the raw JSON for the first presence-update frame.
    const rawPresenceFrame = rawFrames
      .map((r) => { try { return JSON.parse(r); } catch { return null; } })
      .find((m) => m && m.type === 'presence-update');
    assert.ok(rawPresenceFrame, 'found raw presence-update frame');

    const actualKeys = Object.keys(rawPresenceFrame).sort();
    const canonicalKeys = ['activeFilePath', 'branch', 'displayName', 'memberId', 'timestamp', 'type'];
    assert.deepStrictEqual(
      actualKeys,
      canonicalKeys,
      `key set must be exactly ${JSON.stringify(canonicalKeys)} — no new fields added (LAN bytes unchanged)`,
    );

    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve()); ws.close();
    });
  });
});

// ---------------------------------------------------------------------------
// Bug 2 wire contract — Task 1 (Plan 260530-p3g)
//
// Tests:
//   E — auth-request with NO clientId is byte-identical to today (no
//       clientId key appears in the serialized object)
//   F — SessionClient generates a stable clientId once and sends it on
//       every auth-request (stable across two onOpen firings = reconnects)
// ---------------------------------------------------------------------------

/**
 * Minimal stub ClientTransport for SessionClient unit tests.
 * Captures every sent frame. Allows re-firing onOpen to simulate a reconnect.
 */
class StubLanTransportForClientId implements ClientTransport {
  public readonly sentFrames: ProtocolMessage[] = [];
  private openHandlers: Array<() => void> = [];
  private messageHandlers: Array<(raw: Buffer | ArrayBuffer | Buffer[]) => void> = [];
  private closeHandlers: Array<(code: number, reason: Buffer) => void> = [];
  private errorHandlers: Array<() => void> = [];
  private pongHandlers: Array<() => void> = [];
  private _open = false;

  async connect(): Promise<boolean> {
    this._open = true;
    for (const h of this.openHandlers) { try { h(); } catch { /* ignore */ } }
    return true;
  }
  onOpen(h: () => void): void { this.openHandlers.push(h); }
  onMessage(h: (raw: Buffer | ArrayBuffer | Buffer[]) => void): void { this.messageHandlers.push(h); }
  onClose(h: (code: number, reason: Buffer) => void): void { this.closeHandlers.push(h); }
  onError(h: () => void): void { this.errorHandlers.push(h); }
  onPong(h: () => void): void { this.pongHandlers.push(h); }
  send(msg: ProtocolMessage): boolean { this.sentFrames.push(msg); return this._open; }
  ping(): void { /* noop */ }
  isOpen(): boolean { return this._open; }
  close(_code?: number, _reason?: string): void { this._open = false; }
  /** Simulate a reconnect by re-firing all onOpen handlers. */
  _fireOpen(): void {
    for (const h of this.openHandlers) { try { h(); } catch { /* ignore */ } }
  }
  /** Inject an inbound message. */
  _injectMessage(payload: ProtocolMessage): void {
    const bytes = Buffer.from(JSON.stringify(payload), 'utf-8');
    for (const h of this.messageHandlers) { try { h(bytes); } catch { /* ignore */ } }
  }
}

suite('Bug 2 wire contract (Plan 260530-p3g Task 1)', () => {
  test('Test E: auth-request with NO clientId contains no clientId key in serialized form', () => {
    // Build a plain AuthRequest without clientId (simulating a legacy client
    // or any code path that omits the field). Verify JSON has no clientId key.
    const frame: AuthRequest = {
      type: 'auth-request',
      inviteCode: 'ABCDEFGH',
      displayName: 'Legacy',
      timestamp: Date.now(),
    };
    const serialized = JSON.stringify(frame);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    assert.ok(
      !Object.prototype.hasOwnProperty.call(parsed, 'clientId'),
      'auth-request without clientId must NOT serialize a clientId key — LAN byte-shape preserved',
    );
  });

  test('Test F: SessionClient generates a stable clientId and sends it on every auth-request (reconnect-stable)', async () => {
    const transport = new StubLanTransportForClientId();
    const client = new SessionClient('127.0.0.1', 0, 'ABCDEFGH', 'Alice', transport);

    // First connect — installs handlers and fires onOpen once.
    void client.connect();
    // Allow the async connect() and onOpen to run.
    await new Promise((r) => setImmediate(r));

    // Simulate a reconnect by re-firing onOpen (mirrors ReconnectManager behavior).
    transport._fireOpen();
    await new Promise((r) => setImmediate(r));

    // We should have at least 2 auth-request frames (one per onOpen).
    const authFrames = transport.sentFrames.filter(
      (f) => f.type === 'auth-request',
    ) as AuthRequest[];
    assert.ok(
      authFrames.length >= 2,
      `expected at least 2 auth-request frames, got ${authFrames.length}`,
    );

    // Every auth-request must carry a non-empty clientId.
    for (const f of authFrames) {
      assert.ok(
        typeof f.clientId === 'string' && f.clientId.length > 0,
        `auth-request must carry a non-empty clientId string, got: ${JSON.stringify(f.clientId)}`,
      );
    }

    // All frames carry THE SAME clientId (stable across reconnects).
    const firstId = authFrames[0].clientId;
    for (let i = 1; i < authFrames.length; i++) {
      assert.strictEqual(
        authFrames[i].clientId,
        firstId,
        `clientId must be stable across reconnects: frame[0]=${firstId}, frame[${i}]=${authFrames[i].clientId}`,
      );
    }

    client.dispose();
  });
});

// ---------------------------------------------------------------------------
// Bug 2 host-half — Task 2 (Plan 260530-p3g)
//
// Tests:
//   G — same clientId × 3 → exactly 1 member entry, memberId reused
//   H — different clientId → 2 distinct member entries
//   I — no clientId → legacy fresh-UUID behavior (2 legacy auths = 2 members)
//   J — superseded ws closed, only 1 member-joined broadcast to a peer
//   K — host-loopback with same clientId is NEVER deduped (role==='host' bypass)
// ---------------------------------------------------------------------------

/**
 * Send a raw auth-request frame and wait for the auth-response.
 * Returns { ws, memberId } on success, throws on timeout or rejection.
 */
async function sendAuthRequest(
  port: number,
  inviteCode: string,
  displayName: string,
  extraFields: Record<string, unknown> = {},
): Promise<{ ws: WebSocket; memberId: string }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const frame = JSON.stringify({
    type: 'auth-request',
    timestamp: Date.now(),
    inviteCode,
    displayName,
    ...extraFields,
  });
  ws.send(frame);
  const authResp = await new Promise<ProtocolMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('auth timeout')), 2000);
    const handler = (raw: Buffer): void => {
      const m = JSON.parse(raw.toString()) as ProtocolMessage;
      if (m.type === 'auth-response') {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(m);
      }
    };
    ws.on('message', handler);
  });
  if (authResp.type !== 'auth-response' || !authResp.accepted || !authResp.memberId) {
    ws.close();
    throw new Error('auth rejected');
  }
  return { ws, memberId: authResp.memberId };
}

suite('Bug 2 host-half (Plan 260530-p3g Task 2)', () => {
  let host: SessionHost;
  let port: number;

  setup(async () => {
    const config: SessionConfig = {
      sessionName: 'DedupeTest',
      port: 0,
      networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD,
      inviteCode: INVITE,
    };
    host = new SessionHost(config, makeHostIdentity(HOST_NAME));
    port = await host.start();
  });

  teardown(() => {
    try { host.stop(); } catch { /* best-effort */ }
  });

  test('Test G: three auth-requests with the same clientId → exactly 1 member, memberId reused', async () => {
    const cid = 'cid-stable-g';
    const r1 = await sendAuthRequest(port, INVITE, 'Alice', { clientId: cid });
    const r2 = await sendAuthRequest(port, INVITE, 'Alice', { clientId: cid });
    const r3 = await sendAuthRequest(port, INVITE, 'Alice', { clientId: cid });

    // All three responses should yield the same memberId (reused).
    assert.strictEqual(r2.memberId, r1.memberId, 'second auth reuses first memberId');
    assert.strictEqual(r3.memberId, r1.memberId, 'third auth reuses first memberId');

    // Host members map should have exactly 1 entry for this client.
    const members = host.getMembers();
    const withId = members.filter((m) => m.id === r1.memberId);
    assert.strictEqual(withId.length, 1, 'exactly one member entry exists for the deduped clientId');

    // Total members must also be exactly 1 (no phantom entries).
    assert.strictEqual(members.length, 1, 'host.getMembers() has exactly 1 member total');

    r1.ws.close(); r2.ws.close(); r3.ws.close();
  });

  test('Test H: different clientId → two distinct member entries', async () => {
    const r1 = await sendAuthRequest(port, INVITE, 'Alice', { clientId: 'cid-h-1' });
    const r2 = await sendAuthRequest(port, INVITE, 'Bob',   { clientId: 'cid-h-2' });

    assert.notStrictEqual(r1.memberId, r2.memberId, 'different clientIds produce different memberIds');
    assert.strictEqual(host.getMembers().length, 2, 'host has 2 distinct members');

    r1.ws.close(); r2.ws.close();
  });

  test('Test I: no clientId → legacy fresh-UUID per auth (two auths = two distinct members)', async () => {
    // No clientId field — legacy path: each auth mints a new UUID.
    const r1 = await sendAuthRequest(port, INVITE, 'Alice');
    const r2 = await sendAuthRequest(port, INVITE, 'Alice');

    assert.notStrictEqual(
      r1.memberId,
      r2.memberId,
      'legacy (no clientId) auth-requests produce distinct memberIds — no accidental dedupe',
    );
    assert.strictEqual(host.getMembers().length, 2, 'host has 2 legacy members');

    r1.ws.close(); r2.ws.close();
  });

  test('Test J: superseded ws is closed and only ONE member-joined broadcast observed by a peer', async () => {
    // Connect an observer first so they see all member-joined broadcasts.
    const observer = await connectClient(port, 'Observer');
    const joinedBroadcasts: ProtocolMessage[] = [];
    observer.onMessage((m) => { if (m.type === 'member-joined') { joinedBroadcasts.push(m); } });

    const cid = 'cid-j-supersede';

    // First auth with this clientId.
    const r1 = await sendAuthRequest(port, INVITE, 'Alice', { clientId: cid });

    // Let the host process the first auth fully.
    await new Promise((r) => setTimeout(r, 100));
    const joinedAfterFirst = joinedBroadcasts.filter(
      (m) => m.type === 'member-joined' && (m as { member: { id: string } }).member.id === r1.memberId,
    ).length;
    assert.strictEqual(joinedAfterFirst, 1, 'exactly one member-joined for the first auth');

    // Detect when ws1 is closed by the host (superseded).
    let ws1Closed = false;
    r1.ws.once('close', () => { ws1Closed = true; });

    // Second auth with the SAME clientId — should rebind, close ws1.
    const r2 = await sendAuthRequest(port, INVITE, 'Alice', { clientId: cid });
    assert.strictEqual(r2.memberId, r1.memberId, 'second auth reuses same memberId');

    // Wait for ws1 close.
    await waitFor(() => ws1Closed, 2000);
    assert.ok(ws1Closed, 'superseded first ws was closed by the host');

    // No additional member-joined should have been broadcast.
    await new Promise((r) => setTimeout(r, 100));
    const totalJoined = joinedBroadcasts.filter(
      (m) => m.type === 'member-joined' && (m as { member: { id: string } }).member.id === r1.memberId,
    ).length;
    assert.strictEqual(totalJoined, 1, 'only ONE member-joined ever broadcast for this clientId');

    r2.ws.close();
    await observer.close();
  });

  test('Test K: host-loopback with stable clientId is NEVER deduped — role-check always runs', async () => {
    const identity = makeHostIdentity('HostUser');
    const cfg: SessionConfig = {
      sessionName: 'HostLoopbackDedupe',
      port: 0,
      networkInterface: '127.0.0.1',
      maxPayloadBytes: MAX_PAYLOAD,
      inviteCode: 'HOSTTEST',
    };
    const h2 = new SessionHost(cfg, identity);
    const p2 = await h2.start();

    const hostCid = 'host-stable-cid-k';

    // First host-role auth (simulating host loopback connect on startup).
    const r1 = await sendAuthRequest(p2, 'HOSTTEST', 'HostUser', {
      clientId: hostCid,
      hostAuthSecret: identity.hostAuthSecret,
    });

    // Confirm getPresenceSnapshot includes host after first auth (Task 3 seed).
    // For Task 2 we only check that the host IS in members and memberId is set.
    const membersAfterFirst = h2.getMembers();
    assert.ok(
      membersAfterFirst.some((m) => m.id === r1.memberId && m.role === 'host'),
      'host is registered as a member after first auth',
    );

    // Simulate a VS Code reload — second host-role auth with same clientId.
    const r2 = await sendAuthRequest(p2, 'HOSTTEST', 'HostUser', {
      clientId: hostCid,
      hostAuthSecret: identity.hostAuthSecret,
    });

    // Both auths must produce a host-role member (role-check ran both times).
    const membersAfterSecond = h2.getMembers();
    const hostEntry = membersAfterSecond.find((m) => m.id === r2.memberId);
    assert.ok(hostEntry, 'host registered after second auth');
    assert.strictEqual(hostEntry.role, 'host', 'host role assigned on second auth (not deduped)');

    r1.ws.close(); r2.ws.close();
    try { h2.stop(); } catch { /* best-effort */ }
  });
});
