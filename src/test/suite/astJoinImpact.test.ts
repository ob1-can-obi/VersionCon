import * as assert from 'assert';

import { joinImpact } from '../../ast/joinImpact.js';
import type {
  SymbolIndex,
  ReferenceIndex,
  AnalysisResult,
} from '../../ast/types.js';

// -----------------------------------------------------------------------------
// Phase 5 Wave 4 (Plan 05-04) — joinImpact pure-fn unit tests.
//
// joinImpact is the pure-fn symbol/reference join consumed by the Wave 4 worker.
// Tests live host-side without forking — direct import.
//
// Covers:
//   - empty inputs → empty result
//   - changed-symbol detection (added / removed / modified)
//   - file-scoped attribution gate (T-05-05 — cross-file name collisions
//     rejected unless the consuming reference imports FROM the change file)
//   - per-member regrouping
//   - call-site + read-site enumeration
//   - import-bridge invariant: only call/read of a name in a file that imports
//     it from the changed file counts as a caller
//   - determinism: results sorted by (changedIn, name), callers sorted by
//     displayName
//   - unsupportedLanguages passthrough
// -----------------------------------------------------------------------------

function emptySymbols(): SymbolIndex {
  return { functions: [], classes: [], variables: [], imports: [], exports: [] };
}

function emptyRefs(): ReferenceIndex {
  return { calls: [], reads: [], imports: [] };
}

suite('Phase 5 Wave 3 — joinImpact (T-05-05 file-scoped attribution)', () => {
  // ---------- empty / degenerate ----------

  test('empty inputs returns empty AnalysisResult', () => {
    const result = joinImpact(new Map(), new Map(), new Map());
    assert.deepStrictEqual(result, {
      affectedSymbols: [],
      perMember: {},
      unsupportedLanguages: [],
    });
  });

  test('changed file with no member references → empty affectedSymbols (no one cares)', () => {
    const pre = emptySymbols();
    const post: SymbolIndex = {
      ...emptySymbols(),
      functions: [{ name: 'foo', line: 5 }],
    };
    const result = joinImpact(
      new Map([['cart-helpers.ts', { pre, post }]]),
      new Map(),
      new Map(),
    );
    assert.deepStrictEqual(result.affectedSymbols, []);
    assert.deepStrictEqual(result.perMember, {});
  });

  test('unsupportedLanguages passed through verbatim', () => {
    const result = joinImpact(new Map(), new Map(), new Map(), ['java', 'cpp']);
    assert.deepStrictEqual(result.unsupportedLanguages, ['java', 'cpp']);
  });

  // ---------- added / removed / modified detection ----------

  test('added function detected (preSymbols empty → post has foo)', () => {
    const pre = emptySymbols();
    const post: SymbolIndex = {
      ...emptySymbols(),
      functions: [{ name: 'foo', line: 5 }],
    };
    // Member imports + calls foo from cart-helpers.ts.
    const aliceRefs: ReferenceIndex = {
      calls: [{ name: 'foo', line: 34 }],
      reads: [],
      imports: [{ name: 'foo', from: './cart-helpers', line: 1 }],
    };
    const result = joinImpact(
      new Map([['cart-helpers.ts', { pre, post }]]),
      new Map([['alice', new Map([['cart.ts', aliceRefs]])]]),
      new Map([['alice', 'Alice']]),
    );
    assert.strictEqual(result.affectedSymbols.length, 1);
    assert.strictEqual(result.affectedSymbols[0].name, 'foo');
    assert.strictEqual(result.affectedSymbols[0].kind, 'function');
    assert.strictEqual(result.affectedSymbols[0].changedIn, 'cart-helpers.ts');
  });

  test('removed function detected (pre has foo → post empty)', () => {
    const pre: SymbolIndex = { ...emptySymbols(), functions: [{ name: 'foo', line: 5 }] };
    const post = emptySymbols();
    const aliceRefs: ReferenceIndex = {
      calls: [{ name: 'foo', line: 10 }],
      reads: [],
      imports: [{ name: 'foo', from: './cart-helpers', line: 1 }],
    };
    const result = joinImpact(
      new Map([['cart-helpers.ts', { pre, post }]]),
      new Map([['alice', new Map([['cart.ts', aliceRefs]])]]),
      new Map([['alice', 'Alice']]),
    );
    assert.strictEqual(result.affectedSymbols.length, 1);
    assert.strictEqual(result.affectedSymbols[0].name, 'foo');
  });

  test('modified function detected (pre line 5 → post line 8 — line differs)', () => {
    const pre: SymbolIndex = { ...emptySymbols(), functions: [{ name: 'foo', line: 5 }] };
    const post: SymbolIndex = { ...emptySymbols(), functions: [{ name: 'foo', line: 8 }] };
    const aliceRefs: ReferenceIndex = {
      calls: [{ name: 'foo', line: 34 }],
      reads: [],
      imports: [{ name: 'foo', from: './cart-helpers', line: 1 }],
    };
    const result = joinImpact(
      new Map([['cart-helpers.ts', { pre, post }]]),
      new Map([['alice', new Map([['cart.ts', aliceRefs]])]]),
      new Map([['alice', 'Alice']]),
    );
    assert.strictEqual(result.affectedSymbols.length, 1);
    assert.strictEqual(result.affectedSymbols[0].name, 'foo');
    assert.strictEqual(result.affectedSymbols[0].changedIn, 'cart-helpers.ts');
    // callers should contain alice
    const ids = result.affectedSymbols[0].callers.map(c => c.memberId);
    assert.ok(ids.includes('alice'));
  });

  test('unchanged function (same name + same line) NOT detected', () => {
    const sym: SymbolIndex = { ...emptySymbols(), functions: [{ name: 'foo', line: 5 }] };
    const aliceRefs: ReferenceIndex = {
      calls: [{ name: 'foo', line: 34 }],
      reads: [],
      imports: [{ name: 'foo', from: './cart-helpers', line: 1 }],
    };
    const result = joinImpact(
      new Map([['cart-helpers.ts', { pre: sym, post: sym }]]),
      new Map([['alice', new Map([['cart.ts', aliceRefs]])]]),
      new Map([['alice', 'Alice']]),
    );
    assert.deepStrictEqual(result.affectedSymbols, []);
  });

  // ---------- caller enumeration (call + read + import bridge line) ----------

  test('affectedSymbol.callers contains import line AND call line for one consumer', () => {
    const pre = emptySymbols();
    const post: SymbolIndex = { ...emptySymbols(), functions: [{ name: 'foo', line: 5 }] };
    const aliceRefs: ReferenceIndex = {
      calls: [{ name: 'foo', line: 34 }],
      reads: [],
      imports: [{ name: 'foo', from: './cart-helpers', line: 1 }],
    };
    const result = joinImpact(
      new Map([['cart-helpers.ts', { pre, post }]]),
      new Map([['alice', new Map([['cart.ts', aliceRefs]])]]),
      new Map([['alice', 'Alice']]),
    );
    const aliceCallers = result.affectedSymbols[0].callers.filter(c => c.memberId === 'alice');
    // Expect at least the import (line 1) and the call (line 34).
    const lines = aliceCallers.map(c => c.line).sort((a, b) => a - b);
    assert.ok(lines.includes(1));
    assert.ok(lines.includes(34));
    assert.ok(aliceCallers.every(c => c.file === 'cart.ts'));
    assert.ok(aliceCallers.every(c => c.displayName === 'Alice'));
  });

  test('two members both calling the same changed foo → both appear in callers', () => {
    const pre = emptySymbols();
    const post: SymbolIndex = { ...emptySymbols(), functions: [{ name: 'foo', line: 5 }] };
    const aliceRefs: ReferenceIndex = {
      calls: [{ name: 'foo', line: 10 }],
      reads: [],
      imports: [{ name: 'foo', from: './cart-helpers', line: 1 }],
    };
    const bobRefs: ReferenceIndex = {
      calls: [{ name: 'foo', line: 20 }],
      reads: [],
      imports: [{ name: 'foo', from: './cart-helpers', line: 1 }],
    };
    const result = joinImpact(
      new Map([['cart-helpers.ts', { pre, post }]]),
      new Map([
        ['alice', new Map([['cart.ts', aliceRefs]])],
        ['bob', new Map([['checkout.ts', bobRefs]])],
      ]),
      new Map([
        ['alice', 'Alice'],
        ['bob', 'Bob'],
      ]),
    );
    const memberIds = result.affectedSymbols[0].callers.map(c => c.memberId);
    assert.ok(memberIds.includes('alice'));
    assert.ok(memberIds.includes('bob'));
  });

  test('callers sorted by displayName for determinism', () => {
    const pre = emptySymbols();
    const post: SymbolIndex = { ...emptySymbols(), functions: [{ name: 'foo', line: 5 }] };
    const zRefs: ReferenceIndex = {
      calls: [{ name: 'foo', line: 5 }],
      reads: [],
      imports: [{ name: 'foo', from: './ch', line: 1 }],
    };
    const aRefs: ReferenceIndex = {
      calls: [{ name: 'foo', line: 5 }],
      reads: [],
      imports: [{ name: 'foo', from: './ch', line: 1 }],
    };
    const result = joinImpact(
      new Map([['ch.ts', { pre, post }]]),
      new Map([
        ['zane', new Map([['z.ts', zRefs]])],
        ['amy', new Map([['a.ts', aRefs]])],
      ]),
      new Map([
        ['zane', 'Zane'],
        ['amy', 'Amy'],
      ]),
    );
    const names = result.affectedSymbols[0].callers.map(c => c.displayName);
    // Amy < Zane in localeCompare.
    assert.strictEqual(names[0], 'Amy');
    assert.strictEqual(names[names.length - 1], 'Zane');
  });

  // ---------- T-05-05 file-scoped collision rejection ----------

  test('T-05-05: symbol name collision across files — only correct file attributed', () => {
    // changedFiles has `User` in a.ts AND `User` in b.ts (both modified)
    const preA: SymbolIndex = { ...emptySymbols(), classes: [{ name: 'User', line: 1 }] };
    const postA: SymbolIndex = { ...emptySymbols(), classes: [{ name: 'User', line: 3 }] };
    const preB: SymbolIndex = { ...emptySymbols(), classes: [{ name: 'User', line: 1 }] };
    const postB: SymbolIndex = { ...emptySymbols(), classes: [{ name: 'User', line: 5 }] };

    // Member's reference imports User ONLY from './a' — should attribute to a.ts only.
    const consumerRefs: ReferenceIndex = {
      calls: [],
      reads: [{ name: 'User', line: 10 }],
      imports: [{ name: 'User', from: './a', line: 1 }],
    };
    const result = joinImpact(
      new Map([
        ['a.ts', { pre: preA, post: postA }],
        ['b.ts', { pre: preB, post: postB }],
      ]),
      new Map([['alice', new Map([['consumer.ts', consumerRefs]])]]),
      new Map([['alice', 'Alice']]),
    );

    // Both files' User changed but only a.ts's User has callers from alice.
    const aliceForA = result.affectedSymbols.find(
      s => s.changedIn === 'a.ts' && s.callers.some(c => c.memberId === 'alice'),
    );
    const aliceForB = result.affectedSymbols.find(
      s => s.changedIn === 'b.ts' && s.callers.some(c => c.memberId === 'alice'),
    );
    assert.ok(aliceForA, 'alice should be attributed to a.ts User');
    assert.strictEqual(aliceForB, undefined, 'alice should NOT be attributed to b.ts User');
  });

  // ---------- import-bridge invariant ----------

  test('call without import-bridge does NOT count as a caller (strict invariant)', () => {
    const pre = emptySymbols();
    const post: SymbolIndex = { ...emptySymbols(), functions: [{ name: 'foo', line: 5 }] };
    // Member has a call to `foo` but DOES NOT import it from the changed file.
    const aliceRefs: ReferenceIndex = {
      calls: [{ name: 'foo', line: 34 }],
      reads: [],
      imports: [], // no import bridge
    };
    const result = joinImpact(
      new Map([['cart-helpers.ts', { pre, post }]]),
      new Map([['alice', new Map([['cart.ts', aliceRefs]])]]),
      new Map([['alice', 'Alice']]),
    );
    assert.deepStrictEqual(result.affectedSymbols, []);
  });

  // ---------- import path normalization ----------

  test('import path with leading ./ and .ts extension matches the changed file', () => {
    const pre = emptySymbols();
    const post: SymbolIndex = { ...emptySymbols(), functions: [{ name: 'foo', line: 5 }] };
    const aliceRefs: ReferenceIndex = {
      calls: [{ name: 'foo', line: 34 }],
      reads: [],
      // import 'from' uses './cart-helpers' (no extension); changedIn is 'cart-helpers.ts' — should match.
      imports: [{ name: 'foo', from: './cart-helpers', line: 1 }],
    };
    const result = joinImpact(
      new Map([['cart-helpers.ts', { pre, post }]]),
      new Map([['alice', new Map([['cart.ts', aliceRefs]])]]),
      new Map([['alice', 'Alice']]),
    );
    assert.strictEqual(result.affectedSymbols.length, 1);
  });

  test('import path with /index.ts pattern resolves to directory match', () => {
    const pre = emptySymbols();
    const post: SymbolIndex = { ...emptySymbols(), functions: [{ name: 'foo', line: 5 }] };
    const aliceRefs: ReferenceIndex = {
      calls: [{ name: 'foo', line: 34 }],
      reads: [],
      imports: [{ name: 'foo', from: './cart/index', line: 1 }],
    };
    const result = joinImpact(
      new Map([['cart.ts', { pre, post }]]),
      new Map([['alice', new Map([['x.ts', aliceRefs]])]]),
      new Map([['alice', 'Alice']]),
    );
    // 'cart/index' normalizes to 'cart' — matches 'cart.ts' (which normalizes to 'cart')
    assert.strictEqual(result.affectedSymbols.length, 1);
  });

  // ---------- class methods ----------

  test('class with new method emits only the added method as a changed symbol', () => {
    // Pre: class A { foo() {} } → classes: A, functions: A.foo
    // Post: class A { foo() {} bar() {} } → classes: A, functions: A.foo + A.bar
    const pre: SymbolIndex = {
      ...emptySymbols(),
      classes: [{ name: 'A', line: 1 }],
      functions: [{ name: 'A.foo', line: 1 }],
    };
    const post: SymbolIndex = {
      ...emptySymbols(),
      classes: [{ name: 'A', line: 1 }],
      functions: [
        { name: 'A.foo', line: 1 },
        { name: 'A.bar', line: 1 },
      ],
    };
    const refs: ReferenceIndex = {
      calls: [{ name: 'A.bar', line: 5 }],
      reads: [],
      imports: [{ name: 'A', from: './a', line: 1 }],
    };
    const result = joinImpact(
      new Map([['a.ts', { pre, post }]]),
      new Map([['alice', new Map([['x.ts', refs]])]]),
      new Map([['alice', 'Alice']]),
    );
    // Only A.bar should be reported (A.foo unchanged, A unchanged class).
    const names = result.affectedSymbols.map(s => s.name);
    assert.ok(names.includes('A.bar'));
    assert.ok(!names.includes('A.foo'));
    assert.ok(!names.includes('A'));
  });

  // ---------- imports + exports ----------

  test('added import in changedFile yields an "import" kind affectedSymbol when member uses it', () => {
    const pre: SymbolIndex = { ...emptySymbols(), imports: [{ name: 'foo', from: './x', line: 1 }] };
    const post: SymbolIndex = {
      ...emptySymbols(),
      imports: [
        { name: 'foo', from: './x', line: 1 },
        { name: 'bar', from: './x', line: 1 },
      ],
    };
    const refs: ReferenceIndex = {
      calls: [],
      reads: [{ name: 'bar', line: 10 }],
      imports: [{ name: 'bar', from: './cart-helpers', line: 1 }],
    };
    const result = joinImpact(
      new Map([['cart-helpers.ts', { pre, post }]]),
      new Map([['alice', new Map([['consumer.ts', refs]])]]),
      new Map([['alice', 'Alice']]),
    );
    const bar = result.affectedSymbols.find(s => s.name === 'bar');
    assert.ok(bar);
    assert.strictEqual(bar.kind, 'import');
  });

  test('removed export ("breaking change") fires when member imports the removed export', () => {
    const pre: SymbolIndex = { ...emptySymbols(), exports: [{ name: 'x', line: 1 }] };
    const post: SymbolIndex = { ...emptySymbols(), exports: [] };
    const refs: ReferenceIndex = {
      calls: [],
      reads: [{ name: 'x', line: 10 }],
      imports: [{ name: 'x', from: './m', line: 1 }],
    };
    const result = joinImpact(
      new Map([['m.ts', { pre, post }]]),
      new Map([['alice', new Map([['consumer.ts', refs]])]]),
      new Map([['alice', 'Alice']]),
    );
    const x = result.affectedSymbols.find(s => s.name === 'x');
    assert.ok(x);
    assert.strictEqual(x.kind, 'export');
  });

  // ---------- variable value-only changes (NOT detected v1) ----------

  test('variable name + line unchanged (only value changed) is NOT detected (v1 limitation)', () => {
    const pre: SymbolIndex = { ...emptySymbols(), variables: [{ name: 'discountRate', line: 10 }] };
    const post: SymbolIndex = { ...emptySymbols(), variables: [{ name: 'discountRate', line: 10 }] };
    const refs: ReferenceIndex = {
      calls: [],
      reads: [{ name: 'discountRate', line: 5 }],
      imports: [{ name: 'discountRate', from: './prices', line: 1 }],
    };
    const result = joinImpact(
      new Map([['prices.ts', { pre, post }]]),
      new Map([['alice', new Map([['cart.ts', refs]])]]),
      new Map([['alice', 'Alice']]),
    );
    assert.deepStrictEqual(result.affectedSymbols, []);
  });

  // ---------- perMember regrouping ----------

  test('perMember contains entries for callers only — members with no callers absent', () => {
    const pre = emptySymbols();
    const post: SymbolIndex = { ...emptySymbols(), functions: [{ name: 'foo', line: 5 }] };
    const aliceRefs: ReferenceIndex = {
      calls: [{ name: 'foo', line: 5 }],
      reads: [],
      imports: [{ name: 'foo', from: './ch', line: 1 }],
    };
    // Bob has refs but no import-bridge to the change.
    const bobRefs: ReferenceIndex = {
      calls: [{ name: 'foo', line: 5 }],
      reads: [],
      imports: [],
    };
    const result = joinImpact(
      new Map([['ch.ts', { pre, post }]]),
      new Map([
        ['alice', new Map([['a.ts', aliceRefs]])],
        ['bob', new Map([['b.ts', bobRefs]])],
      ]),
      new Map([
        ['alice', 'Alice'],
        ['bob', 'Bob'],
      ]),
    );
    assert.ok('alice' in result.perMember);
    assert.ok(!('bob' in result.perMember));
  });

  test('perMember groups by memberId — alice gets her affectedSymbols only', () => {
    const pre = emptySymbols();
    const postA: SymbolIndex = { ...emptySymbols(), functions: [{ name: 'foo', line: 5 }] };
    const postB: SymbolIndex = { ...emptySymbols(), functions: [{ name: 'bar', line: 5 }] };
    const aliceRefs: ReferenceIndex = {
      calls: [{ name: 'foo', line: 5 }],
      reads: [],
      imports: [{ name: 'foo', from: './a', line: 1 }],
    };
    const bobRefs: ReferenceIndex = {
      calls: [{ name: 'bar', line: 5 }],
      reads: [],
      imports: [{ name: 'bar', from: './b', line: 1 }],
    };
    const result = joinImpact(
      new Map([
        ['a.ts', { pre, post: postA }],
        ['b.ts', { pre, post: postB }],
      ]),
      new Map([
        ['alice', new Map([['xa.ts', aliceRefs]])],
        ['bob', new Map([['xb.ts', bobRefs]])],
      ]),
      new Map([
        ['alice', 'Alice'],
        ['bob', 'Bob'],
      ]),
    );
    assert.strictEqual(result.perMember.alice.length, 1);
    assert.strictEqual(result.perMember.alice[0].name, 'foo');
    assert.strictEqual(result.perMember.bob.length, 1);
    assert.strictEqual(result.perMember.bob[0].name, 'bar');
  });

  // ---------- determinism: affectedSymbols sort ----------

  test('affectedSymbols sorted by (changedIn ASC, name ASC) for determinism', () => {
    const preA = emptySymbols();
    const postA: SymbolIndex = { ...emptySymbols(), functions: [{ name: 'zoom', line: 5 }] };
    const preB = emptySymbols();
    const postB: SymbolIndex = { ...emptySymbols(), functions: [{ name: 'alpha', line: 5 }] };

    const refs: ReferenceIndex = {
      calls: [],
      reads: [{ name: 'zoom', line: 1 }, { name: 'alpha', line: 1 }],
      imports: [
        { name: 'zoom', from: './a', line: 1 },
        { name: 'alpha', from: './b', line: 1 },
      ],
    };
    const result = joinImpact(
      new Map([
        ['b.ts', { pre: preB, post: postB }],   // intentionally inserted FIRST
        ['a.ts', { pre: preA, post: postA }],
      ]),
      new Map([['alice', new Map([['c.ts', refs]])]]),
      new Map([['alice', 'Alice']]),
    );
    assert.strictEqual(result.affectedSymbols.length, 2);
    // a.ts < b.ts so 'zoom' (from a.ts) should be first.
    assert.strictEqual(result.affectedSymbols[0].changedIn, 'a.ts');
    assert.strictEqual(result.affectedSymbols[1].changedIn, 'b.ts');
  });

  // ---------- type contract ----------

  test('return shape is AnalysisResult — has affectedSymbols, perMember, unsupportedLanguages keys', () => {
    const result: AnalysisResult = joinImpact(new Map(), new Map(), new Map());
    assert.ok('affectedSymbols' in result);
    assert.ok('perMember' in result);
    assert.ok('unsupportedLanguages' in result);
  });

  // ---------- joinImpact is synchronous (no Promise) ----------

  test('joinImpact is synchronous — return is not a Promise', () => {
    const out = joinImpact(new Map(), new Map(), new Map());
    assert.ok(!(out instanceof Promise));
  });
});
