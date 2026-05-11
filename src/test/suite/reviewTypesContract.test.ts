import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Phase 6 Wave 1 — source-grep contract pinning.
 *
 * These tests freeze the contract Wave 2/3/4/5 build against:
 *   - src/types/review.ts type module exports
 *   - src/types/chat.ts SystemEventSubKind extension
 *   - src/network/protocol.ts MessageType + ProtocolMessage union + VALID_TYPES
 *   - src/types/branch.ts BranchInfo.requireReview optional field
 *
 * If any of these contracts drift in a future wave, this suite breaks the
 * build immediately — preventing silent regressions like "ProtocolMessage
 * union extended but VALID_TYPES omitted" (which would cause silent
 * parseMessage drops).
 *
 * Pattern follows src/test/suite/filesExclude.test.ts source-grep precedent.
 */
suite('Phase 6 Wave 1 — review types contract (source-grep)', () => {
  const repoRoot = process.cwd();
  const readSrc = (rel: string) =>
    fs.readFileSync(path.resolve(repoRoot, rel), 'utf-8');

  // --- src/types/review.ts ---
  test('src/types/review.ts exports ReviewVote', () => {
    assert.match(readSrc('src/types/review.ts'), /export type ReviewVote\b/);
  });
  test('src/types/review.ts exports ReviewStatus', () => {
    assert.match(readSrc('src/types/review.ts'), /export type ReviewStatus\b/);
  });
  test('src/types/review.ts exports ReviewComment', () => {
    assert.match(readSrc('src/types/review.ts'), /export interface ReviewComment\b/);
  });
  test('src/types/review.ts exports ReviewVoteRecord', () => {
    assert.match(readSrc('src/types/review.ts'), /export interface ReviewVoteRecord\b/);
  });
  test('src/types/review.ts exports ReviewRequest with required + optional fields', () => {
    const s = readSrc('src/types/review.ts');
    assert.match(s, /export interface ReviewRequest\b/);
    for (const f of ['id', 'pushId', 'branch', 'authorMemberId', 'authorDisplayName', 'openedAt', 'status', 'votes', 'comments']) {
      assert.match(s, new RegExp(`\\b${f}\\b`), `ReviewRequest missing field ${f}`);
    }
    assert.match(s, /resolvedAt\?: number/, 'resolvedAt should be optional');
    assert.match(s, /resolvedBy\?: string/, 'resolvedBy should be optional');
    assert.match(s, /resolvedReason\?: 'merged' \| 'abandoned'/, 'resolvedReason should be optional union');
  });

  // --- src/types/chat.ts SystemEventSubKind extension ---
  test('src/types/chat.ts SystemEventSubKind includes 5 new review sub-kinds', () => {
    const s = readSrc('src/types/chat.ts');
    for (const k of [
      "'review-opened'", "'review-comment'", "'review-approved'",
      "'review-changes-requested'", "'review-resolved'",
    ]) {
      assert.ok(s.includes(k), `SystemEventSubKind missing ${k}`);
    }
  });
  test('src/types/chat.ts SystemEventSubKind preserves existing 3 sub-kinds', () => {
    const s = readSrc('src/types/chat.ts');
    for (const k of ["'push'", "'revert'", "'branch-created'"]) {
      assert.ok(s.includes(k), `SystemEventSubKind regressed — missing ${k}`);
    }
  });

  // --- src/network/protocol.ts ---
  test('src/network/protocol.ts MessageType declares 5 new review wire types', () => {
    const s = readSrc('src/network/protocol.ts');
    for (const k of [
      "'review-opened'", "'review-comment'", "'review-vote'",
      "'review-resolved'", "'review-state-sync'",
    ]) {
      assert.ok(s.includes(k), `MessageType missing ${k}`);
    }
  });
  test('src/network/protocol.ts VALID_TYPES set includes 5 new review wire types', () => {
    const s = readSrc('src/network/protocol.ts');
    // Narrow the search to the VALID_TYPES literal block to avoid matching
    // inside JSDoc comments on the wire-message interfaces.
    const m = s.match(/VALID_TYPES[\s\S]*?\]\);/);
    assert.ok(m, 'VALID_TYPES set declaration not found');
    const block = m![0];
    for (const k of [
      "'review-opened'", "'review-comment'", "'review-vote'",
      "'review-resolved'", "'review-state-sync'",
    ]) {
      assert.ok(block.includes(k), `VALID_TYPES missing ${k}`);
    }
  });
  test('src/network/protocol.ts exports 5 review wire interfaces', () => {
    const s = readSrc('src/network/protocol.ts');
    for (const i of [
      'export interface ReviewOpened\\b',
      'export interface ReviewCommentMessage\\b',
      'export interface ReviewVoteMessage\\b',
      'export interface ReviewResolved\\b',
      'export interface ReviewStateSync\\b',
    ]) {
      assert.match(s, new RegExp(i), `Interface ${i} missing`);
    }
  });
  test('src/network/protocol.ts ProtocolMessage union includes 5 review interfaces', () => {
    const s = readSrc('src/network/protocol.ts');
    const m = s.match(/export type ProtocolMessage =[\s\S]*?;/);
    assert.ok(m, 'ProtocolMessage union not found');
    const block = m![0];
    for (const i of ['ReviewOpened', 'ReviewCommentMessage', 'ReviewVoteMessage', 'ReviewResolved', 'ReviewStateSync']) {
      assert.ok(new RegExp(`\\|\\s*${i}\\b`).test(block), `ProtocolMessage missing ${i}`);
    }
  });

  // --- src/types/branch.ts ---
  test('src/types/branch.ts BranchInfo declares optional requireReview', () => {
    const s = readSrc('src/types/branch.ts');
    assert.match(s, /requireReview\?: boolean/);
  });
});
