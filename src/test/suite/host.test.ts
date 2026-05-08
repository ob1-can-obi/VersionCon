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
