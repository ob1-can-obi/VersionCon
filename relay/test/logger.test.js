// relay/test/logger.test.js
//
// Phase 7 — relay logger redaction snapshot tests (plan 07-11).
//
// This file IS the security gate for T-07-03 (Bearer token leak via logs) and
// T-07-04 (payload leak via logs). Each test injects a sensitive-shaped object
// into a pino logger configured IDENTICALLY to relay/src/logger.ts and asserts
// that the serialized output never contains the substring. A failure of any
// assertion means a real-world programmer accidentally logging that shape
// would leak the secret to Fly.io's log pipeline — the FIX goes in
// relay/src/logger.ts, NEVER in this test file. Relaxing the assertions is
// forbidden; the assertions are the security contract.
//
// Architecture: each test builds its own pino logger piped to an in-memory
// Writable buffer (mirrors the LOCKED config in relay/src/logger.ts). The
// source-parity guard test at the bottom reads relay/src/logger.ts and asserts
// each required redact path literal is present — if a maintainer drops a path
// from the source without updating this test, the parity guard fires.
//
// Test runner: Node's built-in `node:test` (no test framework dependency).
// Run via: cd relay && node --test test/logger.test.js
// Build is NOT required first — this file is .js and imports pino at runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Construct a logger with the EXACT same config as relay/src/logger.ts,
 * piped to an in-memory buffer for substring inspection. The redact path
 * list MUST stay in sync with relay/src/logger.ts — the parity-guard test
 * at the bottom of this file enforces this.
 */
function makeTestLogger(level = 'info') {
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString('utf8'));
      cb();
    },
  });
  const logger = pino(
    {
      level,
      redact: {
        paths: [
          'req.headers.authorization',
          'headers.authorization',
          'authorization',
          '*.authorization',
          'envelope.payload',
          '*.payload',
          '*.message',
          '*.body',
          'inviteCode',
          '*.inviteCode',
          'code',
          '*.code',
          'token',
          '*.token',
          'secret',
          '*.secret',
        ],
        remove: true,
      },
      formatters: { level: (label) => ({ level: label }) },
    },
    stream,
  );
  return { logger, lines };
}

// === T-07-03: Bearer token never leaks ===

test('Bearer token in req.headers.authorization is stripped', () => {
  const { logger, lines } = makeTestLogger();
  logger.info({
    event: 'auth-attempt',
    req: { headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.fake-payload.fake-sig' } },
  });
  const out = lines.join('');
  assert.ok(!out.includes('Bearer'), 'Bearer prefix must not appear in log line');
  assert.ok(!out.includes('eyJ'), 'JWT header prefix must not appear');
  assert.ok(!out.includes('fake-payload'), 'JWT payload segment must not appear');
  assert.ok(!out.includes('fake-sig'), 'JWT signature segment must not appear');
  assert.ok(
    !out.includes('"authorization"'),
    'authorization key must be REMOVED (not masked) — remove:true semantics',
  );
});

test('Bearer token in top-level authorization is stripped', () => {
  const { logger, lines } = makeTestLogger();
  logger.info({ event: 'x', authorization: 'Bearer eyJabc.def.ghi' });
  const out = lines.join('');
  assert.ok(!out.includes('Bearer'), 'top-level authorization redacted');
  assert.ok(!out.includes('eyJabc'), 'JWT body redacted');
});

test('Bearer token in nested *.authorization (e.g., headers.authorization) is stripped', () => {
  const { logger, lines } = makeTestLogger();
  logger.info({ event: 'x', headers: { authorization: 'Bearer eyJxyz.uvw.rst' } });
  const out = lines.join('');
  assert.ok(!out.includes('Bearer'), 'nested authorization redacted via *.authorization wildcard');
  assert.ok(!out.includes('eyJxyz'), 'JWT body redacted from nested path');
});

// === T-07-04: Message payload contents never leak ===

test('envelope.payload is stripped entirely (key removed, contents absent)', () => {
  const { logger, lines } = makeTestLogger();
  logger.info({
    event: 'fwd',
    envelope: { sessionId: 'vc-1', payload: { type: 'chat', text: 'SECRETUSERMESSAGE' } },
  });
  const out = lines.join('');
  assert.ok(!out.includes('SECRETUSERMESSAGE'), 'payload plaintext must not appear');
  assert.ok(!out.includes('"type":"chat"'), 'payload type field must not appear');
  assert.ok(
    !out.includes('"payload"'),
    'payload key itself must be removed (remove:true), not replaced with mask',
  );
  assert.ok(
    out.includes('"sessionId":"vc-1"'),
    'sessionId is NOT redacted — it is the routing key and may be logged',
  );
});

test('top-level payload key is stripped via *.payload wildcard', () => {
  const { logger, lines } = makeTestLogger();
  logger.info({ event: 'fwd', wrapper: { payload: { secret: 'NEVERSHOWN' } } });
  const out = lines.join('');
  assert.ok(!out.includes('NEVERSHOWN'), 'nested payload contents absent');
  assert.ok(!out.includes('"payload"'), 'payload key removed');
});

test('*.message and *.body fields are stripped (chat-message and HTTP-body shaped leaks)', () => {
  const { logger, lines } = makeTestLogger();
  logger.info({ event: 'x', frame: { message: 'CHATBODY' }, http: { body: 'HTTPBODY' } });
  const out = lines.join('');
  assert.ok(!out.includes('CHATBODY'), 'message field redacted');
  assert.ok(!out.includes('HTTPBODY'), 'body field redacted');
});

// === T-07-05-aux: Invite code never leaks (defense-in-depth) ===

test('invite code is stripped from inviteCode field', () => {
  const { logger, lines } = makeTestLogger();
  logger.info({ event: 'join-attempt', inviteCode: 'K8M3PQ' });
  const out = lines.join('');
  assert.ok(!out.includes('K8M3PQ'), 'inviteCode value must not appear');
  assert.ok(!out.includes('"inviteCode"'), 'inviteCode key must be removed');
});

test('invite code is stripped from code field (deep-link URL param shape)', () => {
  const { logger, lines } = makeTestLogger();
  logger.info({ event: 'deep-link', query: { code: 'J7N4QR' } });
  const out = lines.join('');
  assert.ok(!out.includes('J7N4QR'), 'code value must not appear');
});

// === Ambient secret hygiene ===

test('top-level token field is stripped', () => {
  const { logger, lines } = makeTestLogger();
  logger.info({ event: 'x', token: 'eyJ.tok.en' });
  const out = lines.join('');
  assert.ok(!out.includes('eyJ.tok.en'), 'token value must not appear');
  assert.ok(!out.includes('"token"'), 'token key must be removed');
});

test('nested *.secret field is stripped', () => {
  const { logger, lines } = makeTestLogger();
  logger.info({ event: 'x', registration: { secret: 'DEEPSECRET' } });
  const out = lines.join('');
  assert.ok(!out.includes('DEEPSECRET'), 'secret value must not appear');
});

// === remove:true vs mask:'***' semantics — the critical pino config detail ===

test('redacted keys are GONE, not replaced with a placeholder string', () => {
  const { logger, lines } = makeTestLogger();
  logger.info({ event: 'x', authorization: 'Bearer foo', envelope: { payload: { a: 1 } } });
  const out = lines.join('');
  // Default pino redact (without remove:true) would emit "authorization":"[Redacted]" or similar.
  // remove:true means the keys are SILENTLY GONE.
  assert.ok(
    !out.includes('[Redacted]'),
    'no [Redacted] placeholder — remove:true should strip the key',
  );
  assert.ok(!out.includes('***'), 'no *** placeholder — remove:true should strip the key');
  // Verify by parsing the emitted JSON:
  const parsed = JSON.parse(out.trim().split('\n').pop());
  assert.equal(parsed.authorization, undefined, 'authorization key absent from parsed JSON');
  assert.equal(parsed.envelope?.payload, undefined, 'envelope.payload absent from parsed JSON');
  assert.equal(parsed.event, 'x', 'non-redacted fields survive');
});

// === Log level filtering (LOG_LEVEL env var honored) ===

test('LOG_LEVEL=warn suppresses info calls', () => {
  const { logger, lines } = makeTestLogger('warn');
  logger.info({ event: 'should-be-suppressed' });
  logger.warn({ event: 'should-appear' });
  const out = lines.join('');
  assert.ok(!out.includes('should-be-suppressed'), 'info call suppressed at warn level');
  assert.ok(out.includes('should-appear'), 'warn call passes through');
});

// === Level formatter (human-readable level field) ===

test('level field is emitted as string label, not numeric', () => {
  const { logger, lines } = makeTestLogger();
  logger.info({ event: 'x' });
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'info', 'level emitted as "info" string, not 30');
});

// === 07-10 structured-event shape preservation ===
// The redact config must NOT accidentally strip event/sessionId/ip from the
// shapes 07-10 already emits ({event:'rate-limit',ip} and {event:'idle-reap',sessionId}).
// These tests pin the contract that 07-10's logging works through this redact
// config unchanged.

test('07-10 rate-limit shape {event,ip} survives redaction', () => {
  const { logger, lines } = makeTestLogger();
  logger.info({ event: 'rate-limit', ip: '203.0.113.42' });
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.event, 'rate-limit', 'event survives');
  assert.equal(parsed.ip, '203.0.113.42', 'ip survives — not in redact set');
});

test('07-10 idle-reap shape {event,sessionId} survives redaction', () => {
  const { logger, lines } = makeTestLogger();
  logger.info({ event: 'idle-reap', sessionId: 'vc-abc-123' });
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.event, 'idle-reap', 'event survives');
  assert.equal(parsed.sessionId, 'vc-abc-123', 'sessionId survives — routing key, never redacted');
});

// === Source parity guard — verify relay/src/logger.ts has the same redact set as this test ===

test('relay/src/logger.ts redact paths match this test (parity guard)', () => {
  const srcPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../src/logger.ts',
  );
  const src = fs.readFileSync(srcPath, 'utf-8');
  // Each path required by Task 1 — assert literal presence in the source. If a
  // maintainer removes any of these from logger.ts without updating this test,
  // the parity guard fires.
  //
  // Note: the host-side join-secret field name (used by 07-09's invite flow) is
  // INTENTIONALLY ABSENT from this list. Per 07-09's source-locality gate
  // (relay/test/router.test.js), relay/src/ files MUST NOT contain that literal
  // — even mentioning the field name would leak intent about the future L3
  // key-derivation seam. The `code` / `*.code` paths cover the deep-link URL
  // parameter shape that carries the join-secret in production traffic; the
  // test logger above still carries the host-side field name as a belt-and-
  // suspenders snapshot assertion (test files are not gated by router.test.js).
  const requiredPaths = [
    "'req.headers.authorization'",
    "'headers.authorization'",
    "'authorization'",
    "'*.authorization'",
    "'envelope.payload'",
    "'*.payload'",
    "'*.message'",
    "'*.body'",
    "'code'",
    "'*.code'",
    "'token'",
    "'*.token'",
    "'secret'",
    "'*.secret'",
  ];
  for (const p of requiredPaths) {
    assert.ok(
      src.includes(p),
      `relay/src/logger.ts must contain redact path ${p} — source/test parity violated`,
    );
  }
  assert.ok(
    src.includes('remove: true'),
    'relay/src/logger.ts must use remove:true (not default mask) — source/test parity violated',
  );
});

// === Server migration guard tests (T-07-04-aux + console.* purge) ===
// These tests fire AFTER Task 3 (server.ts migration) but live in this file so
// the entire 07-11 invariant set lives in one place. They are pre-staged here
// during Task 2's RED phase but will fail until Task 3 ships — that's by design.

test('no console.* calls remain in relay/src/ after logger migration', () => {
  // grep returns exit 1 when no matches — we WANT no matches.
  let matches = '';
  try {
    matches = execSync('grep -rnE "console\\.(log|warn|error)" relay/src/', {
      encoding: 'utf8',
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..'),
    });
  } catch (e) {
    // grep exited 1 == no matches found == success.
    matches = '';
  }
  // Filter out comment-only mentions (e.g., a comment that says "swap console.log for pino").
  // Strip any line whose match is inside a `//` or `*` comment context — naive but sufficient.
  const real = matches
    .split('\n')
    .filter((l) => l && !/^[^:]+:\d+:\s*\/\//.test(l) && !/^[^:]+:\d+:\s*\*/.test(l));
  assert.equal(
    real.length,
    0,
    `console.* calls found in relay/src/ — must use logger:\n${real.join('\n')}`,
  );
});

test('relay/src/server.ts imports logger', () => {
  const srcPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../src/server.ts',
  );
  const src = fs.readFileSync(srcPath, 'utf-8');
  assert.match(
    src,
    /from\s+['"]\.\/logger\.js['"]/,
    'server.ts must import logger from ./logger.js',
  );
});

test('no err.stack or err.message passed to logger calls in relay/src/', () => {
  // Walk relay/src/ for .ts files and check each line containing logger.{info,warn,error,fatal}(
  // for err.stack/err.message in the call args. T-07-04-aux defense.
  const srcDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src');
  function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(p);
      else if (entry.name.endsWith('.ts')) yield p;
    }
  }
  const offenders = [];
  for (const file of walk(srcDir)) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    let inLoggerCall = false;
    let buf = '';
    let startLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/logger\.(warn|error|info|fatal)\s*\(/.test(line)) {
        inLoggerCall = true;
        startLine = i + 1;
      }
      if (inLoggerCall) {
        buf += ' ' + line;
        // Naively close on first balanced ); — sufficient for the simple shapes in server.ts.
        if (line.includes(');')) {
          if (/err\.(stack|message)/.test(buf) || /error\.(stack|message)/.test(buf)) {
            offenders.push(
              `${file}:${startLine} — logger call includes err.stack/err.message: ${buf
                .trim()
                .slice(0, 200)}`,
            );
          }
          inLoggerCall = false;
          buf = '';
        }
      }
    }
  }
  assert.equal(
    offenders.length,
    0,
    `T-07-04-aux violation — error.stack/message in logger args:\n${offenders.join('\n')}`,
  );
});
