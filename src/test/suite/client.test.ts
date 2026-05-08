import * as assert from 'assert';
import { SessionClient } from '../../client/SessionClient.js';
import type {
  ProtocolMessage,
  ChatMessage,
  ChatCleared,
  ChatTruncated,
  ChatHistory,
  PresenceUpdate,
} from '../../network/protocol.js';
import type { ChatRecord, PresenceInfo } from '../../types/chat.js';

// NET-03: Client connects with credentials
suite('SessionClient', () => {
  test('should send auth-request on connect (NET-03)');
  test('should handle auth-response accepted');
  test('should handle auth-response rejected');
  test('should respond to heartbeat-ping with heartbeat-pong');
  test('should not lock workspace during disconnect (SAFE-02)');
});

// NET-05: Connection status
suite('ConnectionStateMachine', () => {
  test('should start in disconnected state (NET-05)');
  test('should transition disconnected -> connected');
  test('should transition connected -> reconnecting');
  test('should transition connected -> disconnected');
  test('should transition reconnecting -> connected');
  test('should transition reconnecting -> disconnected');
  test('should reject invalid transitions');
  test('should notify listeners on status change');
});

suite('ReconnectManager', () => {
  test('should use exponential backoff with jitter');
  test('should cap at maxAttempts');
  test('should reset attempts on success');
});

suite('HeartbeatManager', () => {
  test('should send periodic pings');
  test('should fire onDead when pong not received');
  test('should clear timeout on pong received');
});

// --- Phase 4: Chat + Presence client events (Plan 04-05) --------------------
//
// SessionClient.handleMessage routes the 5 new wire-protocol message types
// into typed events on SessionEventEmitter. These tests construct a client
// (no real WebSocket — connect() is never invoked), register listeners,
// then invoke the private handleMessage directly to verify wire→event
// translation. The private method is reached via a typed bracket cast so
// no `any` escapes into the test bodies.
//
suite('Phase 4 client events', () => {
  let client: SessionClient;

  // Typed accessor for the private handleMessage method. The second
  // argument (onAuth callback) is required by the signature but only
  // fires for auth-response messages; we pass a no-op for these tests.
  type HandleMessageFn = (
    msg: ProtocolMessage,
    onAuth: (success: boolean) => void,
  ) => void;
  const handle = (msg: ProtocolMessage): void => {
    const fn = (client as unknown as { handleMessage: HandleMessageFn })
      .handleMessage;
    fn.call(client, msg, () => {});
  };

  setup(() => {
    // No real connection — we only exercise the message-routing switch.
    client = new SessionClient('127.0.0.1', 0, 'test-invite', 'Tester');
  });

  teardown(() => {
    client.dispose();
  });

  test('chat-message wire → chat-received event with ChatRecord shape', (done) => {
    client.on('chat-received', (record: ChatRecord) => {
      try {
        assert.strictEqual(record.id, 'r1');
        assert.strictEqual(record.kind, 'user');
        assert.strictEqual(record.memberId, 'alice');
        assert.strictEqual(record.memberDisplayName, 'Alice');
        assert.strictEqual(record.body, 'hello');
        assert.strictEqual(record.timestamp, 1700000000000);
        // No subKind / no meta when not present on wire.
        assert.strictEqual(record.subKind, undefined);
        assert.strictEqual(record.meta, undefined);
        done();
      } catch (err) {
        done(err);
      }
    });

    const wire: ChatMessage = {
      type: 'chat-message',
      timestamp: 1700000000000,
      recordId: 'r1',
      kind: 'user',
      memberId: 'alice',
      memberDisplayName: 'Alice',
      body: 'hello',
    };
    handle(wire);
  });

  test('chat-message with subKind=push and meta is preserved on the event', (done) => {
    client.on('chat-received', (record: ChatRecord) => {
      try {
        assert.strictEqual(record.id, 'r2');
        assert.strictEqual(record.kind, 'system');
        assert.strictEqual(record.subKind, 'push');
        assert.deepStrictEqual(record.meta, {
          pushId: 'p1',
          branch: 'main',
          files: ['a.ts'],
        });
        done();
      } catch (err) {
        done(err);
      }
    });

    const wire: ChatMessage = {
      type: 'chat-message',
      timestamp: 1,
      recordId: 'r2',
      kind: 'system',
      subKind: 'push',
      memberId: 'host',
      memberDisplayName: 'Host',
      body: 'pushed',
      meta: { pushId: 'p1', branch: 'main', files: ['a.ts'] },
    };
    handle(wire);
  });

  test('chat-cleared wire → chat-cleared event', (done) => {
    client.on('chat-cleared', (data) => {
      try {
        assert.strictEqual(data.hostMemberId, 'host');
        assert.strictEqual(data.hostDisplayName, 'Host');
        done();
      } catch (err) {
        done(err);
      }
    });

    const wire: ChatCleared = {
      type: 'chat-cleared',
      timestamp: 1,
      hostMemberId: 'host',
      hostDisplayName: 'Host',
    };
    handle(wire);
  });

  test('chat-truncated wire (keep-100-and-activity) → chat-truncated event', (done) => {
    client.on('chat-truncated', (data) => {
      try {
        assert.strictEqual(data.mode, 'keep-100-and-activity');
        assert.strictEqual(data.hostMemberId, 'host');
        assert.strictEqual(data.hostDisplayName, 'Host');
        done();
      } catch (err) {
        done(err);
      }
    });

    const wire: ChatTruncated = {
      type: 'chat-truncated',
      timestamp: 1,
      mode: 'keep-100-and-activity',
      hostMemberId: 'host',
      hostDisplayName: 'Host',
    };
    handle(wire);
  });

  test('chat-truncated wire (activity-only) → chat-truncated event', (done) => {
    client.on('chat-truncated', (data) => {
      try {
        assert.strictEqual(data.mode, 'activity-only');
        done();
      } catch (err) {
        done(err);
      }
    });

    const wire: ChatTruncated = {
      type: 'chat-truncated',
      timestamp: 1,
      mode: 'activity-only',
      hostMemberId: 'host',
      hostDisplayName: 'Host',
    };
    handle(wire);
  });

  test('chat-history wire → chat-history event with branch + records preserved', (done) => {
    client.on('chat-history', (data) => {
      try {
        assert.strictEqual(data.branch, 'main');
        assert.strictEqual(data.records.length, 2);
        assert.strictEqual(data.records[0].id, 'r1');
        assert.strictEqual(data.records[0].kind, 'user');
        assert.strictEqual(data.records[1].id, 'r2');
        assert.strictEqual(data.records[1].kind, 'system');
        assert.strictEqual(data.records[1].subKind, 'push');
        done();
      } catch (err) {
        done(err);
      }
    });

    const wire: ChatHistory = {
      type: 'chat-history',
      timestamp: 1,
      branch: 'main',
      records: [
        {
          id: 'r1',
          kind: 'user',
          memberId: 'a',
          memberDisplayName: 'A',
          body: 'hi',
          timestamp: 1,
        },
        {
          id: 'r2',
          kind: 'system',
          subKind: 'push',
          memberId: 'a',
          memberDisplayName: 'A',
          body: 'pushed',
          timestamp: 2,
        },
      ],
    };
    handle(wire);
  });

  test('presence-update wire → presence-update event with lastUpdated = msg.timestamp', (done) => {
    client.on('presence-update', (info: PresenceInfo) => {
      try {
        assert.strictEqual(info.memberId, 'alice');
        assert.strictEqual(info.displayName, 'Alice');
        assert.strictEqual(info.branch, 'main');
        assert.strictEqual(info.activeFilePath, 'src/foo.ts');
        // Field rename: wire timestamp → PresenceInfo.lastUpdated.
        assert.strictEqual(info.lastUpdated, 1700000000000);
        done();
      } catch (err) {
        done(err);
      }
    });

    const wire: PresenceUpdate = {
      type: 'presence-update',
      timestamp: 1700000000000,
      memberId: 'alice',
      displayName: 'Alice',
      branch: 'main',
      activeFilePath: 'src/foo.ts',
    };
    handle(wire);
  });

  test('presence-update wire with activeFilePath null is forwarded as null', (done) => {
    client.on('presence-update', (info: PresenceInfo) => {
      try {
        assert.strictEqual(info.activeFilePath, null);
        assert.strictEqual(info.memberId, 'a');
        assert.strictEqual(info.lastUpdated, 1);
        done();
      } catch (err) {
        done(err);
      }
    });

    const wire: PresenceUpdate = {
      type: 'presence-update',
      timestamp: 1,
      memberId: 'a',
      displayName: 'A',
      branch: 'main',
      activeFilePath: null,
    };
    handle(wire);
  });
});
