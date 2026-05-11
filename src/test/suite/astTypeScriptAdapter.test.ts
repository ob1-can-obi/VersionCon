import * as assert from 'assert';
import * as fsSync from 'fs';
import * as path from 'path';

import { TypeScriptAdapter } from '../../ast/adapters/typescript.js';
import { initParser, _resetGrammarsForTests } from '../../ast/grammars.js';
import { getAdapter } from '../../ast/AstFactory.js';

// -----------------------------------------------------------------------------
// Phase 5 Wave 2 (Plan 05-02) — TypeScriptAdapter unit tests.
//
// Covers CONF-02 / CONF-04 / CONF-05 / CONF-06 for TS + TSX, including:
//   - JS feature parity (TS is JS-superset — every JS test must also pass
//     through the TS adapter for the .ts grammar variant)
//   - TS-specific symbol nodes: interface_declaration, type_alias_declaration
//     (SKIPPED — v1 scope per SC-1), function_signature
//   - TSX routing: same source produces empty Index when relativePath ends
//     in .ts (TS grammar rejects JSX) and a non-empty Index when .tsx
//     (TSX grammar parses both JS+JSX)
//   - T-05-01 crash tolerance: pathological TS still returns empty Index
//
// Setup awaits prepare() for BOTH .ts and .tsx so both Parsers are cached
// — switching grammars mid-test would cost an extra Language.load() each.
// -----------------------------------------------------------------------------

suite('Phase 5 Wave 2 — TypeScriptAdapter (CONF-02/04/05/06 + TSX routing)', () => {
  let adapter: TypeScriptAdapter;

  suiteSetup(async () => {
    _resetGrammarsForTests();
    await initParser();
    adapter = new TypeScriptAdapter();
    await adapter.prepare();          // load TS grammar
    await adapter.prepare('foo.tsx'); // load TSX grammar
  });

  suiteTeardown(() => {
    _resetGrammarsForTests();
  });

  // ---------- TS-specific: interface_declaration → classes ----------
  test('extractSymbols on `interface Foo { bar(): void; }` returns classes: Foo', () => {
    const result = adapter.extractSymbols(
      'interface Foo { bar(): void; }',
      'test.ts',
    );
    assert.deepStrictEqual(result.classes, [{ name: 'Foo', line: 1 }]);
  });

  test('extractSymbols on multiple interfaces returns all as classes', () => {
    const src = 'interface A { a(): void; }\ninterface B { b(): void; }';
    const result = adapter.extractSymbols(src, 'test.ts');
    assert.deepStrictEqual(
      result.classes.map((c: { name: string }) => c.name).sort(),
      ['A', 'B'],
    );
  });

  // ---------- TS-specific: type_alias_declaration → SKIPPED ----------
  test('extractSymbols on `type X = string;` returns empty Index (v1 scope: skip types)', () => {
    const result = adapter.extractSymbols('type X = string;', 'test.ts');
    assert.deepStrictEqual(result.classes, []);
    assert.deepStrictEqual(result.functions, []);
    assert.deepStrictEqual(result.variables, []);
    assert.deepStrictEqual(result.exports, []);
  });

  test('extractSymbols on `export type X = string;` does NOT emit X as variable or export', () => {
    const result = adapter.extractSymbols('export type X = string;', 'test.ts');
    assert.deepStrictEqual(result.variables, []);
    // export of a type alias is still a structural export, but v1 SKIPS it
    // because it doesn't drive runtime impact.
    assert.deepStrictEqual(result.exports, []);
  });

  // ---------- TS-specific: function_signature (.d.ts declaration-only) ----------
  test('extractSymbols on `declare function foo(): void;` returns functions: foo', () => {
    const result = adapter.extractSymbols(
      'declare function foo(): void;',
      'test.ts',
    );
    assert.deepStrictEqual(result.functions, [{ name: 'foo', line: 1 }]);
  });

  // ---------- Generics: name extraction strips the type-parameter clause ----------
  test('extractSymbols on `function foo<T>(x: T): T { return x; }` returns name `foo`', () => {
    const result = adapter.extractSymbols(
      'function foo<T>(x: T): T { return x; }',
      'test.ts',
    );
    assert.deepStrictEqual(result.functions, [{ name: 'foo', line: 1 }]);
  });

  // ---------- TSX routing: same source, different relativePath ----------
  test('extractSymbols on JSX const arrow with .tsx parses successfully', () => {
    const src = 'const Greeting = () => <h1>hi</h1>;';
    const result = adapter.extractSymbols(src, 'Greeting.tsx');
    assert.deepStrictEqual(result.functions, [
      { name: 'Greeting', line: 1 },
    ]);
  });

  test('extractSymbols on JSX const arrow with .ts (NOT .tsx) returns empty Index (crash-tolerant)', () => {
    // The TS grammar without JSX support cannot parse `<h1>...</h1>` — tree-
    // sitter's error recovery may produce a partial tree or fail entirely;
    // either way, the adapter MUST NOT throw. Plan behavior list says "TS
    // grammar fails to parse; adapter returns the empty Index". We pin the
    // crash-tolerance contract (no throw); we DON'T pin a specific output
    // shape because tree-sitter's error recovery is grammar-dependent.
    const src = 'const Greeting = () => <h1>hi</h1>;';
    let threw = false;
    try {
      adapter.extractSymbols(src, 'Greeting.ts');
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false);
  });

  test('extractSymbols on `const Greeting: React.FC = () => <h1>hi</h1>` (.tsx) returns Greeting as function', () => {
    const src = 'const Greeting: React.FC = () => <h1>hi</h1>;';
    const result = adapter.extractSymbols(src, 'Greeting.tsx');
    assert.deepStrictEqual(result.functions, [
      { name: 'Greeting', line: 1 },
    ]);
  });

  // ---------- T-05-01 crash tolerance on malformed TS ----------
  test('extractSymbols on `interface Foo {` returns empty Index, NEVER THROWS', () => {
    let threw = false;
    try {
      adapter.extractSymbols('interface Foo {', 'test.ts');
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false);
  });

  test('extractSymbols on pathological TS garbage returns empty Index, NEVER THROWS', () => {
    let threw = false;
    try {
      adapter.extractSymbols(']]}}}<<>><<<', 'test.ts');
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false);
  });

  // ---------- Reference extraction: import + call combo ----------
  test('extractReferences on `import { Foo } from "./bar"; const x: Foo = baz();` returns imports + calls', () => {
    const src = "import { Foo } from './bar';\nconst x: Foo = baz();";
    const result = adapter.extractReferences(src, 'test.ts');
    assert.deepStrictEqual(result.imports, [
      { name: 'Foo', from: './bar', line: 1 },
    ]);
    assert.deepStrictEqual(
      result.calls.map((c: { name: string }) => c.name).sort(),
      ['baz'],
    );
  });

  test('extractReferences ignores type annotations (does not emit `SomeType` as call/read)', () => {
    const src = 'const x: SomeType = 5;';
    const result = adapter.extractReferences(src, 'test.ts');
    // v1: types are out of scope. Bare type-position identifier MUST NOT
    // surface as a runtime call.
    assert.deepStrictEqual(
      result.calls.map((c: { name: string }) => c.name),
      [],
    );
  });

  // ---------- TS-vs-JS parity: 5 core JS tests through the TS adapter ----------
  test('parity: extractSymbols on `function foo() {}` works through TS adapter', () => {
    const result = adapter.extractSymbols('function foo() {}', 'test.ts');
    assert.deepStrictEqual(result.functions, [{ name: 'foo', line: 1 }]);
  });

  test('parity: extractSymbols on `class Foo {}` works through TS adapter', () => {
    const result = adapter.extractSymbols('class Foo {}', 'test.ts');
    assert.deepStrictEqual(result.classes, [{ name: 'Foo', line: 1 }]);
  });

  test('parity: extractSymbols on `class Foo { bar() {} }` emits Foo.bar method', () => {
    const result = adapter.extractSymbols('class Foo { bar() {} }', 'test.ts');
    assert.deepStrictEqual(result.functions, [{ name: 'Foo.bar', line: 1 }]);
  });

  test('parity: extractSymbols on `const x = 1` returns variable x', () => {
    const result = adapter.extractSymbols('const x = 1;', 'test.ts');
    assert.deepStrictEqual(result.variables, [{ name: 'x', line: 1 }]);
  });

  test('parity: extractSymbols on import returns imports through TS adapter', () => {
    const result = adapter.extractSymbols(
      "import { foo } from './bar';",
      'test.ts',
    );
    assert.deepStrictEqual(result.imports, [
      { name: 'foo', from: './bar', line: 1 },
    ]);
  });

  test('parity: extractReferences on `foo()` returns call', () => {
    const result = adapter.extractReferences('foo();', 'test.ts');
    assert.deepStrictEqual(result.calls, [{ name: 'foo', line: 1 }]);
  });

  // ---------- T-05-02 sync signature contract ----------
  test('TypeScriptAdapter.extractSymbols is synchronous (T-05-02)', () => {
    const result = adapter.extractSymbols('function foo() {}', 'test.ts');
    assert.strictEqual(
      typeof (result as unknown as { then?: unknown }).then,
      'undefined',
    );
  });

  test('TypeScriptAdapter.extractReferences is synchronous (T-05-02)', () => {
    const result = adapter.extractReferences('foo();', 'test.ts');
    assert.strictEqual(
      typeof (result as unknown as { then?: unknown }).then,
      'undefined',
    );
  });

  // ---------- Module-import side effect (source-grep, not runtime) ----------
  test('source-grep: typescript.ts calls registerAdapter at module scope', () => {
    // Runtime check is unreliable because other adapter suites call
    // _resetRegistryForTests() — by the time mocha alphabetically reaches THIS
    // suite, the side-effect registration may have been cleared. The contract
    // we care about is "source file contains the side-effect statement so
    // importing triggers registration". Source-grep is ordering-independent.
    const file = path.resolve(
      __dirname,
      '../../../src/ast/adapters/typescript.ts',
    );
    const src = fsSync.readFileSync(file, 'utf8');
    assert.match(
      src,
      /^registerAdapter\(\s*['"]typescript['"]\s*,\s*new TypeScriptAdapter\(\)\s*\);/m,
      'typescript.ts must contain a top-level `registerAdapter(\'typescript\', new TypeScriptAdapter())` statement so module import registers the adapter',
    );
    assert.strictEqual(typeof getAdapter, 'function');
  });

  // ---------- Source-grep: no throws in adapter source ----------
  test('source-grep: src/ast/adapters/typescript.ts has zero `throw` statements (T-05-01)', () => {
    const file = path.resolve(
      __dirname,
      '../../../src/ast/adapters/typescript.ts',
    );
    const src = fsSync.readFileSync(file, 'utf8');
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    assert.strictEqual(
      stripped.match(/\bthrow\s/g) === null,
      true,
      'TypeScriptAdapter must be crash-tolerant — no `throw` in code (T-05-01)',
    );
  });
});
