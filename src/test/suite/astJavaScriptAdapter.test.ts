import * as assert from 'assert';
import * as fsSync from 'fs';
import * as path from 'path';

import { JavaScriptAdapter } from '../../ast/adapters/javascript.js';
import { initParser, _resetGrammarsForTests } from '../../ast/grammars.js';
import { getAdapter } from '../../ast/AstFactory.js';

// -----------------------------------------------------------------------------
// Phase 5 Wave 2 (Plan 05-02) — JavaScriptAdapter unit tests.
//
// Covers CONF-02 (symbol extraction), CONF-04 (cross-file references),
// CONF-05 (function-level attribution depends on this index), CONF-06 (smart
// push summary depends on this index).
//
// T-05-01 mitigation (parse crash): 4 pathological inputs feed into both
// extract* methods. Adapter MUST return empty Index, never throw.
//
// T-05-02 mitigation (slowloris parse): adapter's extractSymbols /
// extractReferences MUST be synchronous (no Promise, no setTimeout). Wave 4
// worker enforces a 5s ceiling around each call via Promise.race; async
// methods would race against themselves. Pinned by a typeof + Promise check.
// -----------------------------------------------------------------------------

suite('Phase 5 Wave 2 — JavaScriptAdapter (CONF-02/04/05/06)', () => {
  let adapter: JavaScriptAdapter;

  suiteSetup(async () => {
    // NOTE: do NOT reset the registry here — the JavaScriptAdapter module's
    // import side effect at the top of this file just populated it, and the
    // registry test below ("importing javascript adapter module registers
    // it") would lose its evidence. Tests that need a clean registry must
    // reset locally and re-import the adapter.
    _resetGrammarsForTests();
    await initParser();
    adapter = new JavaScriptAdapter();
    await adapter.prepare();
  });

  suiteTeardown(() => {
    _resetGrammarsForTests();
    // Do NOT _resetRegistryForTests — other adapter suites (e.g.
    // astTypeScriptAdapter.test.ts) rely on the side-effect registration
    // surviving across suite boundaries.
  });

  // ---------- extractSymbols: functions ----------
  test('extractSymbols on `function foo() {}` returns functions: foo @ line 1', () => {
    const result = adapter.extractSymbols('function foo() {}', 'test.js');
    assert.deepStrictEqual(result.functions, [{ name: 'foo', line: 1 }]);
    assert.deepStrictEqual(result.classes, []);
    assert.deepStrictEqual(result.variables, []);
  });

  test('extractSymbols on multiline function reports correct line number (1-based)', () => {
    const src = '\n\nfunction foo() {}\n';
    const result = adapter.extractSymbols(src, 'test.js');
    assert.deepStrictEqual(result.functions, [{ name: 'foo', line: 3 }]);
  });

  test('extractSymbols on multiple top-level functions returns all', () => {
    const src = 'function foo() {}\nfunction bar() {}\nfunction baz() {}';
    const result = adapter.extractSymbols(src, 'test.js');
    assert.deepStrictEqual(
      result.functions.map((f: { name: string }) => f.name).sort(),
      ['bar', 'baz', 'foo'],
    );
  });

  // ---------- extractSymbols: classes + methods ----------
  test('extractSymbols on `class Foo {}` returns classes: Foo @ line 1', () => {
    const result = adapter.extractSymbols('class Foo {}', 'test.js');
    assert.deepStrictEqual(result.classes, [{ name: 'Foo', line: 1 }]);
    assert.deepStrictEqual(result.functions, []);
  });

  test('extractSymbols on `class Foo { bar() {} }` returns class Foo + method Foo.bar', () => {
    const result = adapter.extractSymbols('class Foo { bar() {} }', 'test.js');
    assert.deepStrictEqual(result.classes, [{ name: 'Foo', line: 1 }]);
    assert.deepStrictEqual(result.functions, [{ name: 'Foo.bar', line: 1 }]);
  });

  test('extractSymbols on class with multiple methods returns dotted names', () => {
    const src = 'class Foo {\n  bar() {}\n  baz() {}\n}';
    const result = adapter.extractSymbols(src, 'test.js');
    assert.deepStrictEqual(result.classes, [{ name: 'Foo', line: 1 }]);
    assert.deepStrictEqual(
      result.functions.map((f: { name: string }) => f.name).sort(),
      ['Foo.bar', 'Foo.baz'],
    );
  });

  // ---------- extractSymbols: variables (const/let/var) ----------
  test('extractSymbols on `const x = 1; let y = 2; var z = 3;` returns three variables', () => {
    const result = adapter.extractSymbols(
      'const x = 1; let y = 2; var z = 3;',
      'test.js',
    );
    assert.deepStrictEqual(
      result.variables.map((v: { name: string }) => v.name).sort(),
      ['x', 'y', 'z'],
    );
  });

  // ---------- extractSymbols: arrow function via const binding ----------
  test('extractSymbols on `const foo = () => {}` reports foo as function (not variable)', () => {
    const result = adapter.extractSymbols('const foo = () => {};', 'test.js');
    assert.deepStrictEqual(result.functions, [{ name: 'foo', line: 1 }]);
    assert.deepStrictEqual(result.variables, []);
  });

  test('extractSymbols on `const foo = function() {}` also reports foo as function', () => {
    const result = adapter.extractSymbols('const foo = function() {};', 'test.js');
    assert.deepStrictEqual(result.functions, [{ name: 'foo', line: 1 }]);
    assert.deepStrictEqual(result.variables, []);
  });

  // ---------- extractSymbols: imports (default / named / namespace) ----------
  test('extractSymbols on named import `import { bar } from "./baz"` returns imports', () => {
    const result = adapter.extractSymbols(
      "import { bar } from './baz';",
      'test.js',
    );
    assert.deepStrictEqual(result.imports, [
      { name: 'bar', from: './baz', line: 1 },
    ]);
  });

  test('extractSymbols on default import `import bar from "./baz"` returns imports', () => {
    const result = adapter.extractSymbols("import bar from './baz';", 'test.js');
    assert.deepStrictEqual(result.imports, [
      { name: 'bar', from: './baz', line: 1 },
    ]);
  });

  test('extractSymbols on namespace import `import * as bar from "./baz"` returns imports', () => {
    const result = adapter.extractSymbols(
      "import * as bar from './baz';",
      'test.js',
    );
    assert.deepStrictEqual(result.imports, [
      { name: 'bar', from: './baz', line: 1 },
    ]);
  });

  test('extractSymbols on multiple named imports returns one entry per import', () => {
    const result = adapter.extractSymbols(
      "import { a, b, c } from './m';",
      'test.js',
    );
    assert.deepStrictEqual(
      result.imports.map((i: { name: string }) => i.name).sort(),
      ['a', 'b', 'c'],
    );
    assert.strictEqual(
      result.imports.every((i: { from: string }) => i.from === './m'),
      true,
    );
  });

  // ---------- extractSymbols: exports ----------
  test('extractSymbols on `export const x = 1` returns variable x AND export x', () => {
    const result = adapter.extractSymbols('export const x = 1;', 'test.js');
    assert.deepStrictEqual(result.variables, [{ name: 'x', line: 1 }]);
    assert.deepStrictEqual(result.exports, [{ name: 'x', line: 1 }]);
  });

  test('extractSymbols on `export function foo() {}` returns function foo AND export foo', () => {
    const result = adapter.extractSymbols(
      'export function foo() {}',
      'test.js',
    );
    assert.deepStrictEqual(result.functions, [{ name: 'foo', line: 1 }]);
    assert.deepStrictEqual(result.exports, [{ name: 'foo', line: 1 }]);
  });

  test('extractSymbols on `export default function() {}` returns export "default"', () => {
    const result = adapter.extractSymbols(
      'export default function() {}',
      'test.js',
    );
    assert.deepStrictEqual(result.exports, [{ name: 'default', line: 1 }]);
  });

  test('extractSymbols on `export class Foo {}` returns class Foo AND export Foo', () => {
    const result = adapter.extractSymbols('export class Foo {}', 'test.js');
    assert.deepStrictEqual(result.classes, [{ name: 'Foo', line: 1 }]);
    assert.deepStrictEqual(result.exports, [{ name: 'Foo', line: 1 }]);
  });

  // ---------- extractSymbols: empty / edge cases ----------
  test('extractSymbols on empty string returns the empty Index shape', () => {
    const result = adapter.extractSymbols('', 'test.js');
    assert.deepStrictEqual(result, {
      functions: [],
      classes: [],
      variables: [],
      imports: [],
      exports: [],
    });
  });

  test('extractSymbols on whitespace-only string returns the empty Index', () => {
    const result = adapter.extractSymbols('   \n\n\t  ', 'test.js');
    assert.deepStrictEqual(result.functions, []);
    assert.deepStrictEqual(result.classes, []);
  });

  test('extractSymbols on comment-only file returns the empty Index', () => {
    const result = adapter.extractSymbols(
      '// just a comment\n/* and another */',
      'test.js',
    );
    assert.deepStrictEqual(result.functions, []);
  });

  // ---------- extractSymbols: T-05-01 crash tolerance ----------
  test('extractSymbols on `function foo()` (no body) returns empty Index, NEVER THROWS', () => {
    let threw = false;
    let result;
    try {
      result = adapter.extractSymbols('function foo()', 'test.js');
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'extractSymbols must not throw on syntax error');
    // tree-sitter has error recovery — it may or may not still surface 'foo'
    // as a function. The contract is "no throw" — we don't pin shape here.
    assert.ok(result, 'must return an Index, not undefined');
  });

  test('extractSymbols on `}}}}}{{{{` (pathological garbage) returns empty Index, NEVER THROWS', () => {
    let threw = false;
    let result;
    try {
      result = adapter.extractSymbols('}}}}}{{{{', 'test.js');
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false);
    assert.ok(result);
    // Pathological garbage should produce no real symbols (tree-sitter's error
    // recovery should not invent any).
    assert.deepStrictEqual(result.functions, []);
    assert.deepStrictEqual(result.classes, []);
  });

  test('extractSymbols on 1MB pathological string never throws (T-05-01)', () => {
    const huge = '}'.repeat(1_000_000);
    let threw = false;
    let result;
    try {
      result = adapter.extractSymbols(huge, 'test.js');
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false);
    assert.ok(result);
  });

  test('extractSymbols on binary-like blob returns empty Index, NEVER THROWS (T-05-01)', () => {
    const blob = Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01, 0x02]).toString();
    let threw = false;
    let result;
    try {
      result = adapter.extractSymbols(blob, 'test.js');
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false);
    assert.ok(result);
  });

  // ---------- extractReferences: call expressions ----------
  test('extractReferences on `foo();` returns calls: foo @ line 1', () => {
    const result = adapter.extractReferences('foo();', 'test.js');
    assert.deepStrictEqual(result.calls, [{ name: 'foo', line: 1 }]);
  });

  test('extractReferences on `obj.method();` returns dotted call name', () => {
    const result = adapter.extractReferences('obj.method();', 'test.js');
    assert.deepStrictEqual(result.calls, [{ name: 'obj.method', line: 1 }]);
  });

  test('extractReferences on multi-call program collects all', () => {
    const result = adapter.extractReferences(
      'foo();\nbar();\nbaz();',
      'test.js',
    );
    assert.deepStrictEqual(
      result.calls.map((c: { name: string }) => c.name).sort(),
      ['bar', 'baz', 'foo'],
    );
  });

  // ---------- extractReferences: imports + call combo ----------
  test('extractReferences on import-then-call program returns imports AND calls', () => {
    const src = "import { a } from './b';\na();";
    const result = adapter.extractReferences(src, 'test.js');
    assert.deepStrictEqual(result.imports, [
      { name: 'a', from: './b', line: 1 },
    ]);
    assert.deepStrictEqual(result.calls, [{ name: 'a', line: 2 }]);
  });

  // ---------- extractReferences: empty / edge cases ----------
  test('extractReferences on empty string returns the empty Index', () => {
    const result = adapter.extractReferences('', 'test.js');
    assert.deepStrictEqual(result, { calls: [], reads: [], imports: [] });
  });

  // ---------- extractReferences: performance / size ----------
  test('extractReferences on a 400KB synthetic file completes in <5s', () => {
    // Generate roughly 400KB of synthetic JS: 10_000 lines of `foo(x);`.
    const line = 'foo(x);\n';
    const reps = Math.floor(400_000 / line.length);
    const src = line.repeat(reps);
    const t0 = Date.now();
    const result = adapter.extractReferences(src, 'big.js');
    const dt = Date.now() - t0;
    assert.ok(
      dt < 5000,
      `extractReferences on 400KB took ${dt}ms (must be <5000ms)`,
    );
    // Should have ~reps call records.
    assert.ok(result.calls.length >= reps - 100, `expected ~${reps} calls, got ${result.calls.length}`);
  });

  // ---------- T-05-02 sync signature contract ----------
  test('extractSymbols return value is NOT a Promise (T-05-02 sync contract)', () => {
    const result = adapter.extractSymbols('function foo() {}', 'test.js');
    assert.strictEqual(
      typeof (result as unknown as { then?: unknown }).then,
      'undefined',
      'extractSymbols must be synchronous — no .then on the return',
    );
  });

  test('extractReferences return value is NOT a Promise (T-05-02 sync contract)', () => {
    const result = adapter.extractReferences('foo();', 'test.js');
    assert.strictEqual(
      typeof (result as unknown as { then?: unknown }).then,
      'undefined',
    );
  });

  // ---------- registerAdapter side effect ----------
  test('importing javascript adapter module registers it in the factory', () => {
    // Module-import side effect — verify getAdapter('javascript') is non-null
    // after the import at the top of this file.
    const registered = getAdapter('javascript');
    assert.ok(registered, 'JavaScriptAdapter must register itself on import');
    assert.strictEqual(registered.languageId, 'javascript');
  });

  // ---------- Source-grep contract: no `throw` in adapter source ----------
  test('source-grep: src/ast/adapters/javascript.ts has zero `throw` statements (T-05-01)', () => {
    const file = path.resolve(__dirname, '../../../src/ast/adapters/javascript.ts');
    const src = fsSync.readFileSync(file, 'utf8');
    // Strip comments (single-line + block) so doc references to "throw" don't
    // false-positive.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    assert.strictEqual(
      stripped.match(/\bthrow\s/g) === null,
      true,
      'JavaScriptAdapter must be crash-tolerant — no `throw` in code (T-05-01)',
    );
  });
});
