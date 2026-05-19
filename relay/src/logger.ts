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
//   - T-07-05-aux Information Disclosure (host-side-secret leak,
//     defense-in-depth) — paths covering `code` and `*.code`. These cover the
//     deep-link URL parameter shape (which IS how the join-secret travels from
//     the OS to VS Code on the host side). The HOST-side field name itself is
//     deliberately NOT mentioned here because 07-09's source-locality gate
//     (relay/test/router.test.js) enforces that relay/src/ files NEVER contain
//     that literal. Even mentioning the field name in a comment leaks intent
//     about the future L3 key-derivation seam. Production code cannot receive
//     that field name from the relay's traffic shape anyway (07-09 source-grep);
//     the `code`/`*.code` paths are the security-meaningful defense.
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
      // Host-side-secret defense (T-07-05-aux) — `code` covers the deep-link
      // URL parameter shape the OS uses to carry the join-secret into VS Code
      // on the host side. Pino wildcards only match NESTED paths, so the
      // top-level `code` path is required in addition to `*.code`. The
      // host-side field name itself is intentionally NOT listed here — the
      // 07-09 source-locality gate (relay/test/router.test.js) enforces that
      // relay/src/ files never contain that literal at all, and the traffic
      // shape into the relay never carries it (the host substitutes the
      // verifySecret-derived path before it ever hits this process).
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
