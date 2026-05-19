import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';

// -----------------------------------------------------------------------------
// Phase 7 — T-07-05 mitigation: the invite code must NEVER reach the relay process.
//
// CONTEXT D-07 (line 124-127) locks "Invite code never reaches the relay" as a
// load-bearing invariant for the future L3 key-derivation seam. If the invite
// code ever ends up in relay/src/, the relay could derive the session key —
// defeating future end-to-end encryption.
//
// This suite source-greps relay/src/ at every CI run to catch any regression at
// the filesystem level (no integration test needed). Pattern mirrors the
// source-grep convention established in src/test/suite/wizardValidation.test.ts.
//
// Two tests:
//   1. Directory-wide grep over every .ts file under relay/src/.
//   2. Explicit positive coverage on relay/src/auth.ts (the auth layer is the
//      file most-likely to be tempted to import host-side invite-code helpers)
//      AND a second copy of the T-07-11 algorithm-lock source-grep gate so a
//      regression is caught by EITHER the relay test suite OR the extension
//      test suite (defense in depth).
//
// Suite name uses the em-dash (U+2014) so `--grep "Phase 7.*invite code locality"`
// from the plan's verification block matches.
// -----------------------------------------------------------------------------

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  if (!fsSync.existsSync(dir)) return acc;
  for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walkTsFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

suite('Phase 7 — invite code locality', () => {
  const relaySrcDir = path.resolve(process.cwd(), 'relay/src');
  const authPath = path.join(relaySrcDir, 'auth.ts');

  test('relay/src/ contains zero references to inviteCode / validateInviteCode / INVITE_CODE (T-07-05)', () => {
    const files = walkTsFiles(relaySrcDir);
    assert.ok(
      files.length > 0,
      'relay/src/ must exist and contain TypeScript files (planning prereq from 07-08)',
    );
    const offenders: string[] = [];
    for (const file of files) {
      const src = fsSync.readFileSync(file, 'utf-8');
      if (/inviteCode|validateInviteCode|INVITE_CODE/.test(src)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      `relay/src/ files MUST NOT reference invite-code identifiers (T-07-05 — CONTEXT D-07 line 124-127 locks invite-code-stays-local for the future L3 seam). Offenders: ${offenders.join(', ')}`,
    );
  });

  test('relay/src/auth.ts pins both invariants — no invite-code references AND algorithms locked to HS256 (T-07-05 + T-07-11)', () => {
    assert.ok(
      fsSync.existsSync(authPath),
      `relay/src/auth.ts must exist (created by plan 07-09). Missing path: ${authPath}`,
    );
    const src = fsSync.readFileSync(authPath, 'utf-8');

    assert.doesNotMatch(
      src,
      /inviteCode|validateInviteCode|INVITE_CODE/,
      'relay/src/auth.ts must not reference invite-code identifiers (T-07-05)',
    );

    assert.match(
      src,
      /algorithms:\s*\['HS256'\]/,
      'relay/src/auth.ts must lock JWT verify algorithms to HS256 (T-07-11 algorithm-confusion defense)',
    );
  });
});
