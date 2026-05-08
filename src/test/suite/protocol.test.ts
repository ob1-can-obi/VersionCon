import * as assert from 'assert';
import {
  parseMessage,
  type ChatMessage,
  type ChatCleared,
  type ChatTruncated,
  type ChatHistory,
  type PresenceUpdate,
} from '../../network/protocol.js';
import type { ChatRecord } from '../../types/chat.js';

// Protocol tests will import from ../../network/protocol once Plan 01 creates it
suite('Protocol', () => {
  suite('parseMessage', () => {
    test('should parse valid auth-request message');
    test('should parse valid auth-response message');
    test('should return null for malformed JSON');
    test('should return null for missing type field');
    test('should return null for unknown message type');
    test('should return null for missing timestamp');
  });

  suite('sendMessage', () => {
    test('should serialize a ProtocolMessage to JSON string');
  });

  suite('MessageType discriminated union', () => {
    test('should include all required message types for Phase 1');
  });
});

// --- Phase 4: chat + presence wire types -------------------------------------
//
// Round-trip tests for the five new ProtocolMessage types added by Plan 04-01.
// Tests are pure JSON round-trips with no on-disk fixtures (RESEARCH §"Test fixtures").
//
suite('Phase 4 protocol', () => {
  suite('chat-message', () => {
    test('parseMessage accepts a valid chat-message', () => {
      const valid: ChatMessage = {
        type: 'chat-message',
        timestamp: 1700000000000,
        recordId: 'uuid-1',
        kind: 'user',
        memberId: 'm1',
        memberDisplayName: 'Alice',
        body: 'hello world',
      };
      const parsed = parseMessage(JSON.stringify(valid));
      assert.deepStrictEqual(parsed, valid);
    });

    test('round-trips through JSON.stringify with system-event meta', () => {
      const original: ChatMessage = {
        type: 'chat-message',
        timestamp: 1,
        recordId: 'r',
        kind: 'system',
        subKind: 'push',
        memberId: 'h',
        memberDisplayName: 'Host',
        body: 'pushed',
        meta: { pushId: 'p1', branch: 'main', files: ['a.ts'] },
      };
      const round = parseMessage(JSON.stringify(original));
      assert.deepStrictEqual(round, original);
    });
  });

  suite('chat-cleared', () => {
    test('parseMessage accepts a valid chat-cleared', () => {
      const valid: ChatCleared = {
        type: 'chat-cleared',
        timestamp: 1700000000000,
        hostMemberId: 'h1',
        hostDisplayName: 'Host',
      };
      const parsed = parseMessage(JSON.stringify(valid));
      assert.deepStrictEqual(parsed, valid);
    });

    test('round-trips through JSON.stringify', () => {
      const original: ChatCleared = {
        type: 'chat-cleared',
        timestamp: 42,
        hostMemberId: 'host-7',
        hostDisplayName: 'Carol',
      };
      const round = parseMessage(JSON.stringify(original));
      assert.deepStrictEqual(round, original);
    });
  });

  suite('chat-truncated', () => {
    test("parseMessage accepts mode='keep-100-and-activity'", () => {
      const valid: ChatTruncated = {
        type: 'chat-truncated',
        timestamp: 1700000000000,
        mode: 'keep-100-and-activity',
        hostMemberId: 'h1',
        hostDisplayName: 'Host',
      };
      const parsed = parseMessage(JSON.stringify(valid));
      assert.deepStrictEqual(parsed, valid);
    });

    test("round-trips through JSON.stringify with mode='activity-only'", () => {
      const original: ChatTruncated = {
        type: 'chat-truncated',
        timestamp: 99,
        mode: 'activity-only',
        hostMemberId: 'host-7',
        hostDisplayName: 'Carol',
      };
      const round = parseMessage(JSON.stringify(original));
      assert.deepStrictEqual(round, original);
    });
  });

  suite('chat-history', () => {
    test('parseMessage accepts a valid chat-history with empty records', () => {
      const valid: ChatHistory = {
        type: 'chat-history',
        timestamp: 1700000000000,
        branch: 'main',
        records: [],
      };
      const parsed = parseMessage(JSON.stringify(valid));
      assert.deepStrictEqual(parsed, valid);
    });

    test('round-trips through JSON.stringify with mixed user + system records', () => {
      const userRecord: ChatRecord = {
        id: 'u-1',
        kind: 'user',
        memberId: 'm1',
        memberDisplayName: 'Alice',
        body: 'hi',
        timestamp: 100,
      };
      const systemRecord: ChatRecord = {
        id: 's-1',
        kind: 'system',
        subKind: 'push',
        memberId: 'm2',
        memberDisplayName: 'Bob',
        body: 'pushed 2 files',
        timestamp: 200,
        meta: { pushId: 'p1', branch: 'main', files: ['a.ts', 'b.ts'] },
      };
      const original: ChatHistory = {
        type: 'chat-history',
        timestamp: 300,
        branch: 'main',
        records: [userRecord, systemRecord],
      };
      const round = parseMessage(JSON.stringify(original));
      assert.deepStrictEqual(round, original);
    });
  });

  suite('presence-update', () => {
    test('parseMessage accepts a valid presence-update with activeFilePath=null', () => {
      const valid: PresenceUpdate = {
        type: 'presence-update',
        timestamp: 1700000000000,
        memberId: 'm1',
        displayName: 'Alice',
        branch: 'main',
        activeFilePath: null,
      };
      const parsed = parseMessage(JSON.stringify(valid));
      assert.deepStrictEqual(parsed, valid);
    });

    test('round-trips through JSON.stringify with activeFilePath set', () => {
      const original: PresenceUpdate = {
        type: 'presence-update',
        timestamp: 42,
        memberId: 'm2',
        displayName: 'Bob',
        branch: 'feature-x',
        activeFilePath: 'src/foo.ts',
      };
      const round = parseMessage(JSON.stringify(original));
      assert.deepStrictEqual(round, original);
    });
  });

  test('parseMessage rejects unknown chat-like message type', () => {
    // T-04-01-02: VALID_TYPES gate prevents invented type strings
    // (e.g. 'chat-bogus', 'chat-admin') from passing dispatch.
    const fake = { type: 'chat-bogus', timestamp: 1 };
    assert.strictEqual(parseMessage(JSON.stringify(fake)), null);
  });
});
