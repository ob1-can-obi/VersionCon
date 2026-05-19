// -----------------------------------------------------------------------------
// CloudEnvelope — cloud-mode wire-shape framing for Phase 7
//
// This module defines the v1 envelope that wraps every ProtocolMessage sent
// over a CloudTransport (host ↔ relay ↔ client). It is the single most
// important seam shipped in Phase 7 because:
//
//   (a) The relay forwards envelope BYTES verbatim and reads ONLY
//       envelope.sessionId for routing — it never inspects payload. This
//       lets the relay stay a dumb byte-forwarder that can never see VersionCon
//       protocol semantics. (See 07-CONTEXT.md §"Wire protocol envelope.")
//
//   (b) A future L3 (E2E body encryption) phase flips `encrypted` to true
//       and re-types payload as { ciphertext, iv, tag } — WITHOUT bumping
//       the version field. The `encrypted` boolean is the discriminator.
//       Existing v1 clients MUST surface a typed
//       EnvelopeEncryptedNotSupportedError (loud forward-compat failure,
//       NOT silent drop) so version skew is debuggable immediately.
//
// LanTransport does NOT use this envelope — LAN keeps raw protocol.ts messages
// on the wire (CONTEXT D-06). This module is cloud-only.
//
// Key-order invariant: JSON.stringify walks object keys in insertion order.
// `wrap()` constructs CloudEnvelope fields in canonical order
// (v, sessionId, encrypted, payload) so `serialize()` produces a byte-stable
// snapshot. The byte-shape snapshot test in
// src/test/suite/cloudEnvelope.test.ts pins this contract.
// -----------------------------------------------------------------------------

import type { ProtocolMessage } from './protocol.js';

/**
 * The v1 cloud-mode envelope shape.
 *
 * The literal types `v: 1` and `encrypted: false` are deliberate: when L3
 * lands, this file will gain `interface EncryptedCloudEnvelope { v: 1;
 * sessionId: string; encrypted: true; payload: { ciphertext: string; iv:
 * string; tag: string } }` and `CloudEnvelope` becomes a discriminated union
 * narrowable via `if (env.encrypted) { ... ciphertext branch ... } else
 * { ... ProtocolMessage branch ... }`. Do NOT widen these literals to
 * `number` / `boolean` — that would break the discriminated-union seam.
 */
export interface CloudEnvelope {
  v: 1;
  sessionId: string;
  encrypted: false;
  payload: ProtocolMessage;
  /**
   * OPTIONAL envelope-level routing metadata — 07-05b extension.
   *
   * - Present + string → relay routes to a SINGLE member socket whose
   *   memberId matches (unicast). The relay reads this envelope-level field
   *   directly; it never inspects payload.
   * - Absent → relay applies default fan-out (host→all members, member→host).
   *
   * Byte-shape contract: `wrap()` only assigns this field when the caller
   * passes a defined `target` argument. `JSON.stringify` walks own-enumerable
   * keys, so an undefined target produces NO key in the output — the 07-02
   * locked broadcast snapshot
   * `'{"v":1,"sessionId":"vc-7f3a92","encrypted":false,"payload":{"type":"ping"}}'`
   * remains byte-identical for broadcast frames.
   *
   * Threat model: this is a NAMED carve-out at the envelope level. The relay
   * router may read this field. The payload remains opaque to the relay
   * (T-07-02 invariant preserved — see relay/src/router.ts source-grep gate).
   */
  target?: string;
}

/**
 * Base class for every envelope-shape violation.
 *
 * Callers can `catch (err) { if (err instanceof EnvelopeShapeError) { ... } }`
 * to handle all malformed-envelope cases uniformly.
 */
export class EnvelopeShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeShapeError';
  }
}

/**
 * Specifically thrown when an envelope arrives with `encrypted: true` and
 * this client has not shipped the L3 (E2E body-encryption) crypto layer.
 *
 * Distinct subclass so a future L3 client upgrade path can
 * `instanceof`-discriminate "you're talking to a v1 peer that hasn't shipped
 * crypto yet" vs "garbage on the wire." See CONTEXT.md T-07-04 mitigation.
 *
 * NOTE: extends EnvelopeShapeError so callers catching the base class still
 * catch this — the subclass is purely a refinement for forward-compat
 * diagnostics, not a separate error hierarchy.
 */
export class EnvelopeEncryptedNotSupportedError extends EnvelopeShapeError {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeEncryptedNotSupportedError';
  }
}

/**
 * Construct a v1 envelope around a ProtocolMessage.
 *
 * Field-construction order is the byte-shape contract: JSON.stringify walks
 * keys in insertion order, so v, sessionId, encrypted, payload appear in this
 * exact sequence in the output. The byte-shape snapshot test pins this.
 *
 * Optional `target` argument (07-05b extension): when supplied and not
 * undefined, the envelope gains a `target` field for unicast routing on the
 * relay. When omitted/undefined, the key is NEVER assigned — JSON.stringify
 * never emits it — preserving 07-02's locked broadcast byte-shape snapshot.
 * The conditional-assignment pattern (NOT `target: target ?? undefined`) is
 * deliberate: the latter would serialize as `"target":null` and break the
 * byte-shape contract.
 */
export function wrap(
  sessionId: string,
  payload: ProtocolMessage,
  target?: string,
): CloudEnvelope {
  const envelope: CloudEnvelope = {
    v: 1,
    sessionId,
    encrypted: false,
    payload,
  };
  if (target !== undefined) {
    envelope.target = target;
  }
  return envelope;
}

/**
 * Validate an unknown wire-side value as a CloudEnvelope.
 *
 * Throws EnvelopeShapeError for every malformed shape; throws
 * EnvelopeEncryptedNotSupportedError specifically for the `encrypted: true`
 * forward-compat case. Never returns a partially-validated envelope.
 *
 * Deep validation of `payload`'s `type` discriminator is intentionally NOT
 * done here — that is protocol.ts/parseMessage's responsibility downstream.
 * The envelope's job is framing; the payload's job is protocol.
 */
export function unwrap(raw: unknown): CloudEnvelope {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EnvelopeShapeError('Envelope must be a non-null object');
  }

  // Use an indexable record cast so we can probe fields without TS narrowing.
  const r = raw as Record<string, unknown>;

  if (r.v !== 1) {
    throw new EnvelopeShapeError(`Unsupported envelope version: ${String(r.v)}`);
  }

  if (typeof r.sessionId !== 'string' || r.sessionId.length === 0) {
    throw new EnvelopeShapeError('Envelope missing or empty sessionId');
  }

  if (r.encrypted === true) {
    throw new EnvelopeEncryptedNotSupportedError(
      'Envelope is encrypted (encrypted:true) but this client has not shipped ' +
        'the E2E crypto layer — upgrade required',
    );
  }
  if (r.encrypted !== false) {
    throw new EnvelopeShapeError('Envelope encrypted flag must be a boolean');
  }

  if (
    r.payload === undefined ||
    r.payload === null ||
    typeof r.payload !== 'object'
  ) {
    throw new EnvelopeShapeError('Envelope missing payload');
  }

  // Optional `target` field (07-05b extension): must be a string when present.
  // Absence is the broadcast-fan-out signal; absence is fine.
  if (r.target !== undefined && typeof r.target !== 'string') {
    throw new EnvelopeShapeError('Envelope target must be a string when present');
  }

  // Shape validated above; payload's discriminator is protocol.ts's responsibility.
  return raw as CloudEnvelope;
}

/**
 * Serialize an envelope to JSON. Output is byte-stable because `wrap()`
 * builds the object with fields in canonical order.
 *
 * Intentionally no replacer or whitespace argument — that would break
 * byte-shape determinism and ripple into the snapshot test.
 */
export function serialize(env: CloudEnvelope): string {
  return JSON.stringify(env);
}

/**
 * Parse + validate a raw JSON wire string. Wraps JSON.parse failures in
 * EnvelopeShapeError so callers see exactly one typed-error surface.
 *
 * Does NOT use a JSON.parse reviver — that would break byte-shape determinism.
 */
export function deserialize(raw: string): CloudEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EnvelopeShapeError('Envelope payload is not valid JSON');
  }
  return unwrap(parsed);
}
