import * as assert from 'assert';
import {
  parseMessage,
  type AuthRequest,
  type ChatMessage,
  type ChatMessageAmend,
  type ChatCleared,
  type ChatTruncated,
  type ChatHistory,
  type PresenceUpdate,
} from '../../network/protocol.js';
import type { ChatRecord } from '../../types/chat.js';
import type { AffectedSymbol } from '../../ast/types.js';

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

// ---------------------------------------------------------------------------
// Phase 5 Wave 5 (Plan 05-05): chat-message-amend wire shape.
//
// Host broadcasts AFTER the synchronous chat-message (push system event) so
// clients can patch the original record's meta with AST-derived
// affectedSymbols + unsupportedLanguages. Older clients (pre-Phase 5) reject
// the type at parseMessage — verified by the "older-client graceful" test
// in pushSmartSummary.test.ts which simulates the older VALID_TYPES set.
// ---------------------------------------------------------------------------

suite('Phase 5 protocol — chat-message-amend (Plan 05-05)', () => {
  const symA: AffectedSymbol = {
    name: 'calculateTotal',
    kind: 'function',
    changedIn: 'cart-helpers.ts',
    callers: [
      { memberId: 'alice', displayName: 'Alice', file: 'cart.ts', line: 34 },
    ],
  };

  test('parseMessage accepts a valid chat-message-amend round-trip', () => {
    const valid: ChatMessageAmend = {
      type: 'chat-message-amend',
      timestamp: 1700000000000,
      recordId: 'record-uuid-1',
      affectedSymbols: [symA],
      unsupportedLanguages: [],
    };
    const parsed = parseMessage(JSON.stringify(valid));
    assert.deepStrictEqual(parsed, valid);
  });

  test('parseMessage accepts an empty affectedSymbols with non-empty unsupportedLanguages (fallback-tooltip case)', () => {
    // The plan locks this case: when affectedSymbols is empty but
    // unsupportedLanguages has entries, host STILL fires the amend so
    // clients can render the "Symbol analysis unavailable for…" tooltip.
    const valid: ChatMessageAmend = {
      type: 'chat-message-amend',
      timestamp: 42,
      recordId: 'record-uuid-2',
      affectedSymbols: [],
      unsupportedLanguages: ['java', 'cpp'],
    };
    const round = parseMessage(JSON.stringify(valid));
    assert.deepStrictEqual(round, valid);
  });

  test('parseMessage round-trips multiple affectedSymbols verbatim', () => {
    const symB: AffectedSymbol = {
      name: 'discountRate',
      kind: 'variable',
      changedIn: 'pricing.ts',
      callers: [
        { memberId: 'bob', displayName: 'Bob', file: 'checkout.ts', line: 12 },
        { memberId: 'alice', displayName: 'Alice', file: 'cart.ts', line: 89 },
      ],
    };
    const valid: ChatMessageAmend = {
      type: 'chat-message-amend',
      timestamp: 99,
      recordId: 'record-uuid-3',
      affectedSymbols: [symA, symB],
      unsupportedLanguages: [],
    };
    const round = parseMessage(JSON.stringify(valid));
    assert.deepStrictEqual(round, valid);
  });

  test('parseMessage rejects chat-message-amend with non-number timestamp (parse gate enforced)', () => {
    // parseMessage's timestamp gate must reject — same posture as every
    // other type. The amend is no exception.
    const malformed = JSON.stringify({
      type: 'chat-message-amend',
      timestamp: 'not-a-number',
      recordId: 'r1',
      affectedSymbols: [],
      unsupportedLanguages: [],
    });
    assert.strictEqual(parseMessage(malformed), null);
  });
});

// ---------------------------------------------------------------------------
// Phase 4.1 (Plan 04.1-01): AuthRequest gains optional hostAuthSecret field.
//
// The field is populated ONLY by the host's loopback SessionClient (plan
// 04.1-03 wires it). Plan 04.1-02 reads it server-side to gate role:'host'.
// This suite asserts the wire-shape contract — backwards-compat (omitted
// field round-trips) and forward-compat (set field round-trips).
// ---------------------------------------------------------------------------

suite('AuthRequest hostAuthSecret round-trip (Phase 4.1)', () => {
  test('round-trips without hostAuthSecret (backwards-compat)', () => {
    const original: AuthRequest = {
      type: 'auth-request',
      timestamp: 1234567890,
      inviteCode: 'ABCDEFGH',
      displayName: 'Alice',
    };
    const serialized = JSON.stringify(original);
    const parsed = parseMessage(serialized);
    assert.ok(parsed, 'parseMessage returned non-null');
    assert.strictEqual(parsed!.type, 'auth-request');
    const auth = parsed as AuthRequest;
    assert.strictEqual(auth.inviteCode, 'ABCDEFGH');
    assert.strictEqual(auth.displayName, 'Alice');
    assert.strictEqual(auth.hostAuthSecret, undefined,
      'hostAuthSecret omitted by sender remains undefined after parse');
  });

  test('round-trips WITH hostAuthSecret (forward-compat)', () => {
    const secret = 'secret-uuid-abc-123';
    const original: AuthRequest = {
      type: 'auth-request',
      timestamp: 1234567890,
      inviteCode: 'ABCDEFGH',
      displayName: 'HostUser',
      hostAuthSecret: secret,
    };
    const serialized = JSON.stringify(original);
    const parsed = parseMessage(serialized);
    assert.ok(parsed, 'parseMessage returned non-null');
    assert.strictEqual(parsed!.type, 'auth-request');
    const auth = parsed as AuthRequest;
    assert.strictEqual(auth.inviteCode, 'ABCDEFGH');
    assert.strictEqual(auth.displayName, 'HostUser');
    assert.strictEqual(auth.hostAuthSecret, secret,
      'hostAuthSecret round-trips verbatim through JSON.stringify -> parseMessage');
  });

  test('parseMessage tolerates malformed hostAuthSecret type without throwing (server-side validation deferred to plan 04.1-02)', () => {
    // The wire is untrusted; a malicious client could send hostAuthSecret as
    // a non-string. parseMessage's job is only to JSON.parse + return the
    // message; type-narrowing happens at the consumer. This test pins that
    // contract: parse succeeds, type discriminator preserved, downstream
    // (plan 04.1-02 handleAuthRequest) is responsible for typeof checks.
    const malformed = JSON.stringify({
      type: 'auth-request',
      timestamp: 1234567890,
      inviteCode: 'ABCDEFGH',
      displayName: 'Attacker',
      hostAuthSecret: { evil: 'object' },
    });
    const parsed = parseMessage(malformed);
    assert.ok(parsed, 'parseMessage returns non-null on type-valid frames');
    assert.strictEqual(parsed!.type, 'auth-request');
    // We do NOT assert hostAuthSecret value here — plan 04.1-02 enforces
    // typeof === 'string' before trusting it for role:'host' assignment.
  });
});
