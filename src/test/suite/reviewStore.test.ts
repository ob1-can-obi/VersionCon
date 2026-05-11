import * as assert from 'assert';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';

import { ReviewStore } from '../../filesystem/ReviewStore.js';
import type { ReviewRequest, ReviewVoteRecord } from '../../types/review.js';

/**
 * Per-test temp dir helper — mirrors PushHistory test setup
 * (src/test/suite/filesystem.test.ts). Each `make()` call returns a
 * fresh `.versioncon` root that is wiped in the suite's `afterEach`.
 */
function makeTmpVersionconDir(): string {
  return path.join(os.tmpdir(), `versioncon-reviewstore-${crypto.randomBytes(8).toString('hex')}`);
}

function makeReview(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    id: crypto.randomUUID(),
    pushId: crypto.randomBytes(8).toString('hex'),
    branch: 'main',
    authorMemberId: 'm-alice',
    authorDisplayName: 'Alice',
    openedAt: Date.now(),
    status: 'open',
    votes: [],
    comments: [],
    ...overrides,
  };
}

function makeVote(overrides: Partial<ReviewVoteRecord> = {}): ReviewVoteRecord {
  return {
    reviewerMemberId: 'm-bob',
    reviewerDisplayName: 'Bob',
    vote: 'approved',
    votedAt: Date.now(),
    ...overrides,
  };
}

suite('Phase 6 Wave 1 — ReviewStore CRUD', () => {
  let versionconDir: string;
  const cleanup: string[] = [];

  setup(() => {
    versionconDir = makeTmpVersionconDir();
    cleanup.push(versionconDir);
  });

  teardown(async () => {
    while (cleanup.length > 0) {
      const dir = cleanup.shift()!;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('constructor does NOT touch disk', async () => {
    const store = new ReviewStore(versionconDir);
    // No file/dir should be created until load() or upsertRequest() runs.
    await assert.rejects(fs.access(versionconDir));
    void store;
  });

  test('load(branch) on missing reviews/ dir returns 0 without throwing', async () => {
    const store = new ReviewStore(versionconDir);
    const loaded = await store.load('main');
    assert.strictEqual(loaded, 0, 'missing reviews dir should resolve to 0 loaded');
    assert.deepStrictEqual(store.getAll(), []);
  });

  test('upsertRequest writes the correct path .versioncon/branches/<branch>/reviews/<pushId>.json', async () => {
    const store = new ReviewStore(versionconDir);
    const req = makeReview({ branch: 'main', pushId: 'p-xyz-123' });
    await store.upsertRequest(req);
    const expected = path.join(versionconDir, 'branches', 'main', 'reviews', 'p-xyz-123.json');
    await assert.doesNotReject(fs.access(expected), `expected file ${expected} to exist`);
    const raw = await fs.readFile(expected, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.pushId, 'p-xyz-123');
    assert.strictEqual(parsed.id, req.id);
  });

  test('upsertRequest updates the in-memory index by pushId', async () => {
    const store = new ReviewStore(versionconDir);
    const req = makeReview({ pushId: 'pid-1' });
    await store.upsertRequest(req);
    const got = store.getReview('pid-1');
    assert.ok(got, 'getReview should return the upserted record');
    assert.strictEqual(got!.id, req.id);
  });

  test('upsertRequest re-call with same pushId overwrites file + in-memory', async () => {
    const store = new ReviewStore(versionconDir);
    const v1 = makeReview({ pushId: 'pid-2', status: 'open' });
    await store.upsertRequest(v1);
    const v2: ReviewRequest = { ...v1, status: 'approved', votes: [makeVote()] };
    await store.upsertRequest(v2);
    const got = store.getReview('pid-2');
    assert.strictEqual(got!.status, 'approved', 'status should reflect the last write');
    assert.strictEqual(got!.votes.length, 1, 'votes should reflect the last write');
    // Disk file should also reflect the last write.
    const filePath = path.join(versionconDir, 'branches', v1.branch, 'reviews', 'pid-2.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.status, 'approved');
  });

  test('load round-trips a previously-upserted review (fresh store sees prior write)', async () => {
    const writer = new ReviewStore(versionconDir);
    const req = makeReview({ pushId: 'pid-rt', branch: 'feature-x', authorDisplayName: 'Carol' });
    await writer.upsertRequest(req);

    const reader = new ReviewStore(versionconDir);
    const count = await reader.load('feature-x');
    assert.strictEqual(count, 1, 'load count should be 1');
    const got = reader.getReview('pid-rt');
    assert.ok(got);
    assert.strictEqual(got!.id, req.id);
    assert.strictEqual(got!.authorDisplayName, 'Carol');
    assert.strictEqual(got!.branch, 'feature-x');
  });

  test('getReview returns undefined for unknown pushId', () => {
    const store = new ReviewStore(versionconDir);
    assert.strictEqual(store.getReview('does-not-exist'), undefined);
  });

  test('getReview is a defensive deep copy — mutating result cannot corrupt internal state', async () => {
    const store = new ReviewStore(versionconDir);
    const req = makeReview({ pushId: 'pid-defensive', votes: [] });
    await store.upsertRequest(req);
    const first = store.getReview('pid-defensive')!;
    first.votes.push(makeVote({ reviewerMemberId: 'mutation-injected' }));
    first.status = 'abandoned';
    const second = store.getReview('pid-defensive')!;
    assert.strictEqual(second.votes.length, 0, 'internal votes array should be unaffected');
    assert.strictEqual(second.status, 'open', 'internal status should be unaffected');
  });

  test('getAll returns a defensive copy of all reviews', async () => {
    const store = new ReviewStore(versionconDir);
    const r1 = makeReview({ pushId: 'p1', branch: 'main' });
    const r2 = makeReview({ pushId: 'p2', branch: 'main' });
    const r3 = makeReview({ pushId: 'p3', branch: 'feature' });
    await store.upsertRequest(r1);
    await store.upsertRequest(r2);
    await store.upsertRequest(r3);
    const all = store.getAll();
    assert.strictEqual(all.length, 3);
    // Mutating the returned array does not affect the store.
    all.pop();
    assert.strictEqual(store.getAll().length, 3, 'getAll mutation must not affect internal state');
  });

  test('getOpenForBranch filters by status === open AND branch', async () => {
    const store = new ReviewStore(versionconDir);
    await store.upsertRequest(makeReview({ pushId: 'p-open-main', branch: 'main', status: 'open' }));
    await store.upsertRequest(makeReview({ pushId: 'p-approved-main', branch: 'main', status: 'approved' }));
    await store.upsertRequest(makeReview({ pushId: 'p-open-feature', branch: 'feature', status: 'open' }));
    await store.upsertRequest(makeReview({ pushId: 'p-abandoned-main', branch: 'main', status: 'abandoned' }));

    const mainOpens = store.getOpenForBranch('main');
    assert.strictEqual(mainOpens.length, 1, 'only one open review on main');
    assert.strictEqual(mainOpens[0].pushId, 'p-open-main');

    const featureOpens = store.getOpenForBranch('feature');
    assert.strictEqual(featureOpens.length, 1);
    assert.strictEqual(featureOpens[0].pushId, 'p-open-feature');

    assert.deepStrictEqual(store.getOpenForBranch('does-not-exist'), []);
  });

  test('after upsert moves status to approved, getOpenForBranch no longer returns the review', async () => {
    const store = new ReviewStore(versionconDir);
    const req = makeReview({ pushId: 'p-evolve', branch: 'main', status: 'open' });
    await store.upsertRequest(req);
    assert.strictEqual(store.getOpenForBranch('main').length, 1);
    await store.upsertRequest({ ...req, status: 'approved' });
    assert.strictEqual(store.getOpenForBranch('main').length, 0);
  });

  test('load tolerates a corrupt JSON file (skips, does not throw, valid neighbours still load)', async () => {
    // Pre-seed the reviews directory with a valid file + a corrupt one.
    const reviewsDir = path.join(versionconDir, 'branches', 'main', 'reviews');
    await fs.mkdir(reviewsDir, { recursive: true });
    const valid = makeReview({ pushId: 'p-valid', branch: 'main' });
    await fs.writeFile(path.join(reviewsDir, 'p-valid.json'), JSON.stringify(valid));
    await fs.writeFile(path.join(reviewsDir, 'p-corrupt.json'), '{this is not valid json');

    const store = new ReviewStore(versionconDir);
    // load must not throw even though one file is malformed.
    const count = await assert.doesNotReject(() => store.load('main'));
    void count;
    // The valid review IS loaded.
    assert.ok(store.getReview('p-valid'), 'valid review must be in the index');
    // The corrupt review is NOT loaded.
    assert.strictEqual(store.getReview('p-corrupt'), undefined, 'corrupt review must NOT be in the index');
    assert.strictEqual(store.getAll().length, 1);
  });

  test('load ignores non-JSON files in the reviews directory', async () => {
    const reviewsDir = path.join(versionconDir, 'branches', 'main', 'reviews');
    await fs.mkdir(reviewsDir, { recursive: true });
    const valid = makeReview({ pushId: 'p-valid-2', branch: 'main' });
    await fs.writeFile(path.join(reviewsDir, 'p-valid-2.json'), JSON.stringify(valid));
    await fs.writeFile(path.join(reviewsDir, 'README.md'), '# not a review');
    await fs.writeFile(path.join(reviewsDir, '.DS_Store'), 'macos cruft');

    const store = new ReviewStore(versionconDir);
    const count = await store.load('main');
    assert.strictEqual(count, 1);
    assert.ok(store.getReview('p-valid-2'));
  });

  test('load rejects JSON files missing required pushId/id fields without throwing', async () => {
    const reviewsDir = path.join(versionconDir, 'branches', 'main', 'reviews');
    await fs.mkdir(reviewsDir, { recursive: true });
    await fs.writeFile(path.join(reviewsDir, 'missing-fields.json'), JSON.stringify({ foo: 'bar' }));

    const store = new ReviewStore(versionconDir);
    const count = await store.load('main');
    assert.strictEqual(count, 0, 'object without pushId/id should not be loaded');
    assert.deepStrictEqual(store.getAll(), []);
  });
});
