import * as assert from 'assert';
import {
  wrap,
  unwrap,
  serialize,
  deserialize,
  EnvelopeShapeError,
  EnvelopeEncryptedNotSupportedError,
  type CloudEnvelope,
} from '../../network/CloudEnvelope.js';
import type { ProtocolMessage } from '../../network/protocol.js';

// -----------------------------------------------------------------------------
// Phase 7 Plan 07-02 — CloudEnvelope wire-shape contract
//
// CloudEnvelope is the cloud-mode framing layer between SessionHost/Client
// (typed ProtocolMessage) and the relay's byte-pass-through path. It is the
// single most important seam shipped in Phase 7 because:
//   (a) the relay forwards envelope bytes VERBATIM and reads ONLY
//       envelope.sessionId for routing — it never inspects payload.
//   (b) a future L3 (E2E body encryption) phase will flip `encrypted` to true
//       without bumping the version field. Existing v1 clients MUST surface
//       a typed EnvelopeEncryptedNotSupportedError (loud forward-compat
//       failure, NOT silent drop) when they see encrypted:true on the wire.
//
// The byte-shape snapshot test is the literal forward-compat contract:
//   '{"v":1,"sessionId":"vc-7f3a92","encrypted":false,"payload":{"type":"ping"}}'
// Key order is part of the contract — JSON.stringify walks object keys in
// insertion order, so wrap() must construct fields in canonical order.
// -----------------------------------------------------------------------------

// Suite 1 — byte-shape snapshot (forward-compat contract)
suite('Phase 7 — envelope shape', () => {
  test('wrap produces v:1 / encrypted:false / sessionId / payload exactly', () => {
    const payload = { type: 'ping' } as unknown as ProtocolMessage;
    const env = wrap('vc-7f3a92', payload);

    assert.strictEqual(env.v, 1, 'envelope.v must be the literal 1');
    assert.strictEqual(
      env.encrypted,
      false,
      'envelope.encrypted must be the literal false in v1',
    );
    assert.strictEqual(env.sessionId, 'vc-7f3a92', 'sessionId round-trips');
    assert.deepStrictEqual(env.payload, { type: 'ping' }, 'payload is deep-equal');
  });

  test('serialize emits stable byte-identical JSON with key order v, sessionId, encrypted, payload', () => {
    const payload = { type: 'ping' } as unknown as ProtocolMessage;
    const actual = serialize(wrap('vc-7f3a92', payload));
    const expected =
      '{"v":1,"sessionId":"vc-7f3a92","encrypted":false,"payload":{"type":"ping"}}';
    assert.strictEqual(
      actual,
      expected,
      'byte-shape snapshot must match the locked wire contract',
    );
  });

  test('deserialize round-trips byte-identical JSON through unwrap', () => {
    const json =
      '{"v":1,"sessionId":"vc-7f3a92","encrypted":false,"payload":{"type":"ping"}}';
    const env = deserialize(json);
    const reserialized = serialize(env);
    assert.strictEqual(
      reserialized,
      json,
      'deserialize → serialize must be byte-identical (round-trip stability)',
    );
  });

  test('wrap preserves a real ProtocolMessage payload (deep-equal)', () => {
    // Discretionary happy-path test — covers the type compatibility seam with
    // a concrete ProtocolMessage shape (AuthRequest from protocol.ts).
    const auth = {
      type: 'auth-request',
      inviteCode: 'K8M3PQ',
      displayName: 'Alice',
      timestamp: 1234567890,
    } as unknown as ProtocolMessage;
    const env: CloudEnvelope = wrap('vc-abc123', auth);
    assert.deepStrictEqual(env.payload, auth, 'payload is preserved by reference-shape');
    const json = serialize(env);
    const back = deserialize(json);
    assert.deepStrictEqual(back.payload, auth, 'payload survives serialize/deserialize');
  });
});

// Suite 2 — every unwrap rejection path is a typed throw
suite('Phase 7 — envelope reject', () => {
  test('unwrap rejects non-object input', () => {
    assert.throws(() => unwrap('not-an-object'), EnvelopeShapeError);
    assert.throws(() => unwrap(null), EnvelopeShapeError);
    assert.throws(() => unwrap(undefined), EnvelopeShapeError);
    assert.throws(() => unwrap([]), EnvelopeShapeError);
    assert.throws(() => unwrap(42), EnvelopeShapeError);
  });

  test('unwrap rejects wrong envelope version v:2', () => {
    assert.throws(
      () =>
        unwrap({
          v: 2,
          sessionId: 'x',
          encrypted: false,
          payload: { type: 'ping' },
        }),
      EnvelopeShapeError,
    );
    // Also reject missing v entirely.
    assert.throws(
      () => unwrap({ sessionId: 'x', encrypted: false, payload: { type: 'ping' } }),
      EnvelopeShapeError,
    );
  });

  test('unwrap rejects missing sessionId', () => {
    assert.throws(
      () => unwrap({ v: 1, encrypted: false, payload: { type: 'ping' } }),
      EnvelopeShapeError,
    );
    assert.throws(
      () => unwrap({ v: 1, sessionId: '', encrypted: false, payload: { type: 'ping' } }),
      EnvelopeShapeError,
    );
    assert.throws(
      () => unwrap({ v: 1, sessionId: 42, encrypted: false, payload: { type: 'ping' } }),
      EnvelopeShapeError,
    );
  });

  test('unwrap rejects encrypted:true with EnvelopeEncryptedNotSupportedError', () => {
    // This is the forward-compat loud-failure case. The error MUST be
    // specifically EnvelopeEncryptedNotSupportedError (NOT just the generic
    // EnvelopeShapeError) so a future L3 client can instanceof-discriminate
    // "you're talking to a v1 peer that hasn't shipped crypto yet" vs
    // "garbage on the wire."
    assert.throws(
      () =>
        unwrap({
          v: 1,
          sessionId: 'x',
          encrypted: true,
          payload: { ciphertext: 'aGVsbG8=', iv: 'AAAAAA==', tag: 'tttt' },
        }),
      EnvelopeEncryptedNotSupportedError,
      'encrypted:true must throw the typed L3-skew error',
    );
    // Operator-friendly substring check (Task 1 discretion).
    assert.throws(
      () =>
        unwrap({
          v: 1,
          sessionId: 'x',
          encrypted: true,
          payload: { ciphertext: 'aGVsbG8=', iv: 'AAAAAA==', tag: 'tttt' },
        }),
      /encrypted/i,
      'error message must mention encryption for operator debuggability',
    );
    // Subclass relationship: EnvelopeEncryptedNotSupportedError IS an
    // EnvelopeShapeError, so callers using the base class still catch it.
    try {
      unwrap({
        v: 1,
        sessionId: 'x',
        encrypted: true,
        payload: {},
      });
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(
        err instanceof EnvelopeEncryptedNotSupportedError,
        'thrown error is EnvelopeEncryptedNotSupportedError',
      );
      assert.ok(
        err instanceof EnvelopeShapeError,
        'EnvelopeEncryptedNotSupportedError extends EnvelopeShapeError',
      );
    }
  });

  test('unwrap rejects non-boolean encrypted flag (not the L3 case)', () => {
    // Anything other than the literals true/false on the encrypted field is
    // wire garbage — generic EnvelopeShapeError, NOT the L3-skew class.
    assert.throws(
      () =>
        unwrap({
          v: 1,
          sessionId: 'x',
          encrypted: 'false',
          payload: { type: 'ping' },
        }),
      EnvelopeShapeError,
    );
  });

  test('unwrap rejects missing payload', () => {
    assert.throws(
      () => unwrap({ v: 1, sessionId: 'x', encrypted: false }),
      EnvelopeShapeError,
    );
    assert.throws(
      () => unwrap({ v: 1, sessionId: 'x', encrypted: false, payload: null }),
      EnvelopeShapeError,
    );
    assert.throws(
      () => unwrap({ v: 1, sessionId: 'x', encrypted: false, payload: 'not-an-object' }),
      EnvelopeShapeError,
    );
  });

  test('deserialize wraps malformed JSON in EnvelopeShapeError', () => {
    assert.throws(() => deserialize('{not-json'), EnvelopeShapeError);
    assert.throws(() => deserialize(''), EnvelopeShapeError);
    // Valid JSON whose top-level value isn't an object also fails through unwrap.
    assert.throws(() => deserialize('42'), EnvelopeShapeError);
    assert.throws(() => deserialize('null'), EnvelopeShapeError);
  });
});
