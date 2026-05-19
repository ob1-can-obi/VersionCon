// relay/src/logger.ts
//
// Phase 7 — relay structured logging singleton (plan 07-11).
//
// Sole responsibility: expose a configured pino logger whose `redact` rules
// physically strip (remove:true, NOT mask) every sensitive shape that could
// reach a log call — bearer tokens, message payloads, invite codes, and the
// ambient secret/token vocabulary.
//
// Why remove:true and not the default '[Redacted]' mask: a placeholder string
// still signals "a field with this name existed in the logged object" to anyone
// reading Fly.io's log stream. `remove:true` strips the key entirely so the
// observer cannot infer field presence — closes T-07-03 (bearer leak in logs)
// and T-07-04 (payload leak in logs) at the LIBRARY level, not just by
// programmer discipline.
//
// Threat coverage (see .planning/phases/07-cloud-mode-relay-server/07-11-PLAN.md
// <threat_model>):
//   - T-07-03 Repudiation/Disclosure (Bearer leak) — paths covering
//     `req.headers.authorization`, `headers.authorization`, `authorization`,
//     `*.authorization`, `token`, `*.token`.
//   - T-07-04 Information Disclosure (payload leak) — paths covering
//     `envelope.payload`, `*.payload`, `*.message`, `*.body`.
//   - T-07-05-aux Information Disclosure (invite-code leak, defense-in-depth) —
//     paths covering `inviteCode`, `*.inviteCode`, `code`, `*.code`.
//   - T-07-04-aux Information Disclosure via err.stack/err.message — handled at
//     CALL SITE discipline in server.ts/auth.ts (this file cannot redact a
//     string that's been pre-formatted into the message); enforced by a
//     source-walker test in relay/test/logger.test.js.
//
// Required call shape (server.ts/auth.ts MUST honor): every log call passes an
// OBJECT as the first arg, beginning with an `event` discriminator string —
// never a printf-style template, never a pre-serialized JSON string. Examples:
//   logger.info({event: 'connection-open', sessionId, role, ip});
//   logger.warn({event: 'auth-fail', sessionId, reason});
//
// Destination: pino's default `pino.destination(1)` (stdout). Fly.io ingests
// stdout/stderr into its log pipeline; no transport/pretty-print is configured
// here. Local-dev pretty output is opt-in via `flyctl logs | npx pino-pretty`
// (documented in 07-12's README).

import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      // Bearer token defense (T-07-03)
      'req.headers.authorization',
      'headers.authorization',
      'authorization',
      '*.authorization',
      // Payload defense (T-07-04)
      'envelope.payload',
      '*.payload',
      '*.message',
      '*.body',
      // Invite-code defense (T-07-05-aux belt-and-suspenders — invite codes
      // never reach the relay per the source-grep gate in 07-09, but redact
      // anyway in case a future maintainer logs a join-attempt object).
      // Top-level + wildcard variants — pino wildcards only match nested paths,
      // so explicit top-level entries are required.
      'inviteCode',
      '*.inviteCode',
      'code',
      '*.code',
      // Ambient secret hygiene
      'token',
      '*.token',
      'secret',
      '*.secret',
    ],
    // CRITICAL: strip keys entirely instead of replacing with '[Redacted]'.
    // Removal prevents key-name signaling — an observer cannot infer that a
    // request had an authorization header from the log presence of the key
    // name with a masked value. This is the security contract.
    remove: true,
  },
  formatters: {
    // Emit `"level":"info"` instead of pino's default numeric `"level":30`.
    // Makes Fly.io / grep / pino-pretty all align on a human-readable level.
    level: (label) => ({ level: label }),
  },
});
