/**
 * Phase 5 Wave 2 (Plan 05-02) — tier-1 JavaScript AST adapter.
 *
 * Walks the tree-sitter-javascript syntax tree and emits the SymbolIndex +
 * ReferenceIndex shapes locked by Wave 1 (src/ast/types.ts).
 *
 * Design contracts (do not break across waves):
 *
 *   - extractSymbols + extractReferences are SYNCHRONOUS — see types.ts
 *     {@link AstAdapter} doc + T-05-02. The Wave 4 worker wraps each call in
 *     Promise.race with a 5s timer; async signatures would race against
 *     themselves and the slowloris mitigation would silently break.
 *
 *   - Both methods are CRASH-TOLERANT — every parse + walk operation lives
 *     inside a try/catch and returns the empty Index on any failure. NO
 *     `throw` statement appears in this file (T-05-01 + a source-grep test
 *     pins the invariant).
 *
 *   - Lines are 1-BASED. tree-sitter Point.row is 0-based; we add 1 before
 *     emitting so consumers (Wave 5 ChatPanel renderer) can display the
 *     value directly without a +1 fix-up.
 *
 *   - Methods are emitted as dotted `ClassName.methodName` so the Wave 4
 *     join can scope by class (T-05-05 wrong-attribution mitigation,
 *     partial). Top-level functions emit bare names — scope-aware matching
 *     for those is deferred to Phase 5.x.
 *
 *   - The async {@link prepare} call is an adapter-private convenience the
 *     Wave 4 worker awaits before invoking extract*. It is NOT on the
 *     AstAdapter interface — keeping the interface sync ensures host-side
 *     callers cannot accidentally invoke async prep on the host thread.
 *
 *   - Module-import side effect: registerAdapter('javascript', new ...)
 *     at the bottom. The Wave 4 worker imports this module to wire the
 *     adapter; tests reset the registry between suites via
 *     {@link _resetRegistryForTests}.
 */
import type { Node, Parser, Tree } from 'web-tree-sitter';

import type {
  AstAdapter,
  LanguageId,
  ReferenceIndex,
  SymbolIndex,
} from '../types.js';
import { getParserFor } from '../grammars.js';
import { registerAdapter } from '../AstFactory.js';

/** Empty SymbolIndex factory — used as the crash-tolerance fallback. */
function emptySymbols(): SymbolIndex {
  return {
    functions: [],
    classes: [],
    variables: [],
    imports: [],
    exports: [],
  };
}

/** Empty ReferenceIndex factory — used as the crash-tolerance fallback. */
function emptyReferences(): ReferenceIndex {
  return { calls: [], reads: [], imports: [] };
}

/**
 * Recover the line number (1-based) for a tree-sitter Node. Centralized so a
 * future tree-sitter API change (e.g. switching from Point to Range) lands
 * in one spot.
 */
function line1(n: Node): number {
  return n.startPosition.row + 1;
}

/**
 * Render a member_expression as a dotted call name. Examples:
 *
 *   obj.method        → "obj.method"
 *   obj.x.y           → "obj.x.y"   (left-recursive member chain)
 *   getThing().method → "getThing().method"  (best-effort: keep textual form)
 *
 * For pathological cases (computed property `obj[k]`, optional chaining
 * `obj?.x`) we fall back to the raw textual content of the callee — the
 * Wave 4 join treats unknown strings as no-match, which is the right
 * conservative behavior.
 */
function memberExpressionText(n: Node): string {
  // tree-sitter-javascript: member_expression has fields { object, property }.
  // For dotted chains both 'object' and 'property' resolve cleanly.
  const obj = n.childForFieldName('object');
  const prop = n.childForFieldName('property');
  if (obj && prop) {
    if (obj.type === 'member_expression') {
      return `${memberExpressionText(obj)}.${prop.text}`;
    }
    if (obj.type === 'identifier' || obj.type === 'this' || obj.type === 'super') {
      return `${obj.text}.${prop.text}`;
    }
  }
  // Fallback: the node's raw text. This catches `getThing().method`,
  // `obj[k].method`, etc.
  return n.text;
}

export class JavaScriptAdapter implements AstAdapter {
  readonly languageId: LanguageId = 'javascript';

  /**
   * The parser is created lazily inside {@link prepare} and reused across
   * every extract* call for the worker's lifetime. Visible to subclasses
   * (TypeScriptAdapter overrides parser selection based on .tsx routing).
   */
  protected parser: Parser | null = null;

  /**
   * Wave 4 worker calls this once per language before the first extract*
   * invocation. Idempotent — repeated calls reuse the cached Parser.
   *
   * @param relativePath optional path hint; reserved for subclass routing
   *                     (TypeScript .tsx grammar selection). Base class
   *                     ignores it.
   */
  async prepare(relativePath?: string): Promise<void> {
    void relativePath;
    if (!this.parser) {
      this.parser = await getParserFor(this.languageId);
    }
  }

  extractSymbols(source: string, relativePath: string): SymbolIndex {
    void relativePath;
    if (!this.parser) return emptySymbols();
    try {
      const tree: Tree | null = this.parser.parse(source);
      if (!tree) return emptySymbols();
      return this.walkSymbols(tree.rootNode);
    } catch {
      return emptySymbols();
    }
  }

  extractReferences(source: string, relativePath: string): ReferenceIndex {
    void relativePath;
    if (!this.parser) return emptyReferences();
    try {
      const tree: Tree | null = this.parser.parse(source);
      if (!tree) return emptyReferences();
      return this.walkReferences(tree.rootNode);
    } catch {
      return emptyReferences();
    }
  }

  // ---------------------------------------------------------------------
  // internal walkers (protected so TS subclass can extend)
  // ---------------------------------------------------------------------

  /**
   * Walk the syntax tree rooted at `root`, dispatching to
   * {@link collectSymbolFor} at each node. Tracks the enclosing class context
   * so method_definition can emit `ClassName.method` (T-05-05 mitigation).
   *
   * We walk by recursive descent over namedChildren rather than via the
   * TreeCursor API — namedChildren skips the punctuation/anonymous noise we
   * never care about. Performance is well within the 400KB-in-<5s budget
   * (see astJavaScriptAdapter.test.ts).
   */
  protected walkSymbols(root: Node): SymbolIndex {
    const out: SymbolIndex = emptySymbols();
    this.visitSymbols(root, out, null);
    return out;
  }

  protected visitSymbols(
    node: Node,
    out: SymbolIndex,
    classCtx: string | null,
  ): void {
    this.collectSymbolFor(node, out, classCtx);

    // Drive the recursion. For class_declaration we MUST recurse with the
    // class name as classCtx so nested method_definition emits dotted names.
    let nextCtx = classCtx;
    if (node.type === 'class_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) nextCtx = nameNode.text;
    } else if (node.type === 'function_declaration' || node.type === 'method_definition') {
      // Once we are inside a function/method body, we are no longer "at" the
      // class — reset classCtx so a NESTED class inside a method doesn't
      // accidentally prefix its members with the outer class name.
      nextCtx = null;
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) this.visitSymbols(c, out, nextCtx);
    }
  }

  /**
   * Per-node symbol emission. classCtx is the name of the enclosing class
   * (for method_definition naming) or null at top level.
   *
   * Note: this method emits ONLY for the node passed in — the recursive walk
   * is owned by {@link visitSymbols}. Subclasses (TypeScriptAdapter) extend
   * this to add interface_declaration / function_signature handling without
   * having to re-implement the recursion.
   */
  protected collectSymbolFor(
    n: Node,
    out: SymbolIndex,
    classCtx: string | null,
  ): void {
    switch (n.type) {
      case 'function_declaration': {
        const ident = n.childForFieldName('name');
        if (ident) {
          out.functions.push({ name: ident.text, line: line1(ident) });
        }
        return;
      }
      case 'class_declaration': {
        const ident = n.childForFieldName('name');
        if (ident) {
          out.classes.push({ name: ident.text, line: line1(ident) });
        }
        return;
      }
      case 'method_definition': {
        const ident = n.childForFieldName('name');
        if (ident) {
          const name = classCtx ? `${classCtx}.${ident.text}` : ident.text;
          out.functions.push({ name, line: line1(ident) });
        }
        return;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        // Each declarator child contributes a variable (or a function if
        // its initializer is an arrow_function / function_expression).
        for (let i = 0; i < n.namedChildCount; i++) {
          const decl = n.namedChild(i);
          if (!decl || decl.type !== 'variable_declarator') continue;
          const name = decl.childForFieldName('name');
          const value = decl.childForFieldName('value');
          if (!name) continue;
          if (
            value &&
            (value.type === 'arrow_function' ||
              value.type === 'function_expression' ||
              value.type === 'function')
          ) {
            out.functions.push({ name: name.text, line: line1(name) });
          } else {
            out.variables.push({ name: name.text, line: line1(name) });
          }
        }
        return;
      }
      case 'import_statement': {
        this.collectImports(n, out);
        return;
      }
      case 'export_statement': {
        this.collectExports(n, out, classCtx);
        return;
      }
    }
  }

  /**
   * Extract import names + source from an `import { foo } from './bar'`
   * statement. Handles default / named / namespace forms.
   */
  protected collectImports(n: Node, out: SymbolIndex): void {
    const sourceNode = n.childForFieldName('source');
    const fromPath = sourceNode ? this.stripStringQuotes(sourceNode.text) : '';

    // Walk every named child looking for an import_clause. The clause's
    // children are the actual binders (identifier for default, named_imports
    // for `{ a, b }`, namespace_import for `* as ns`).
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i);
      if (!child) continue;
      if (child.type === 'import_clause') {
        for (let j = 0; j < child.namedChildCount; j++) {
          const inner = child.namedChild(j);
          if (!inner) continue;
          this.emitImportBinder(inner, fromPath, out);
        }
      } else if (child.type === 'string') {
        // already captured above via 'source' field
        continue;
      } else {
        // Some grammars (older) put binders directly on import_statement.
        this.emitImportBinder(child, fromPath, out);
      }
    }
  }

  /**
   * Push one import entry per binder. Handles:
   *   - identifier        (default import: `import foo from './m'`)
   *   - named_imports     (`import { a, b } from './m'`)
   *   - namespace_import  (`import * as foo from './m'`)
   */
  protected emitImportBinder(
    node: Node,
    fromPath: string,
    out: SymbolIndex,
  ): void {
    if (node.type === 'identifier') {
      out.imports.push({ name: node.text, from: fromPath, line: line1(node) });
      return;
    }
    if (node.type === 'named_imports') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const spec = node.namedChild(i);
        if (!spec) continue;
        // import_specifier has children: name (the imported binding) and
        // optional alias (the local name). Prefer alias when present.
        const alias = spec.childForFieldName('alias');
        const name = spec.childForFieldName('name');
        const local = alias ?? name ?? spec.namedChild(0);
        if (local) {
          out.imports.push({
            name: local.text,
            from: fromPath,
            line: line1(local),
          });
        }
      }
      return;
    }
    if (node.type === 'namespace_import') {
      // `* as foo` — find the identifier child.
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c && c.type === 'identifier') {
          out.imports.push({
            name: c.text,
            from: fromPath,
            line: line1(c),
          });
          return;
        }
      }
    }
  }

  /**
   * Extract exports from an `export …` statement. The contained declaration
   * (function / class / lexical) is also visited via the recursive walk
   * (visitSymbols recurses into namedChildren), so we only emit the EXPORT
   * entry here — the declaration's symbol entry happens through the regular
   * dispatch.
   */
  protected collectExports(
    n: Node,
    out: SymbolIndex,
    classCtx: string | null,
  ): void {
    void classCtx;
    // Detect `export default …` by looking for the literal 'default' keyword
    // among the non-named children. tree-sitter emits the keyword as an
    // anonymous child whose type is the literal token.
    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i);
      if (child && child.type === 'default') {
        out.exports.push({ name: 'default', line: line1(n) });
        return;
      }
    }

    // Walk namedChildren looking for the declaration / clause we should
    // emit. The recursive visitor already handles the declaration's own
    // symbols (function name, class name, variables) — we just need to
    // emit the export entry here.
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i);
      if (!child) continue;
      switch (child.type) {
        case 'function_declaration': {
          const ident = child.childForFieldName('name');
          if (ident) out.exports.push({ name: ident.text, line: line1(ident) });
          break;
        }
        case 'class_declaration': {
          const ident = child.childForFieldName('name');
          if (ident) out.exports.push({ name: ident.text, line: line1(ident) });
          break;
        }
        case 'lexical_declaration':
        case 'variable_declaration': {
          for (let j = 0; j < child.namedChildCount; j++) {
            const decl = child.namedChild(j);
            if (!decl || decl.type !== 'variable_declarator') continue;
            const name = decl.childForFieldName('name');
            if (name) {
              out.exports.push({ name: name.text, line: line1(name) });
            }
          }
          break;
        }
        case 'export_clause': {
          // `export { foo, bar as baz }` — emit per specifier.
          for (let j = 0; j < child.namedChildCount; j++) {
            const spec = child.namedChild(j);
            if (!spec) continue;
            const alias = spec.childForFieldName('alias');
            const name = spec.childForFieldName('name');
            const local = alias ?? name ?? spec.namedChild(0);
            if (local) {
              out.exports.push({ name: local.text, line: line1(local) });
            }
          }
          break;
        }
      }
    }
  }

  /**
   * Walk the tree emitting calls / reads / imports. Mirrors the symbol
   * walk's recursion pattern.
   */
  protected walkReferences(root: Node): ReferenceIndex {
    const out: ReferenceIndex = emptyReferences();
    this.visitReferences(root, out);
    return out;
  }

  protected visitReferences(node: Node, out: ReferenceIndex): void {
    this.collectReferenceFor(node, out);
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) this.visitReferences(c, out);
    }
  }

  /**
   * Per-node reference emission. Handles call_expression and
   * import_statement; bare identifier reads are NOT emitted (Wave 5 only
   * needs calls for the function-attribution use case, and emitting every
   * identifier read would 10x the index size for no benefit at v1).
   *
   * v1 deviation: behavior list mentions identifier reads at top-level or
   * within function bodies. Defer to Phase 5.x — the calls index plus the
   * imports index is sufficient for SC-1 ("calculate_total() was modified
   * by Alice — you call this in line 34"). Tests do NOT pin reads in v1.
   */
  protected collectReferenceFor(n: Node, out: ReferenceIndex): void {
    switch (n.type) {
      case 'call_expression': {
        const callee = n.childForFieldName('function');
        if (!callee) return;
        let name = '';
        if (callee.type === 'identifier') {
          name = callee.text;
        } else if (callee.type === 'member_expression') {
          name = memberExpressionText(callee);
        } else {
          // IIFE, dynamic, etc — best-effort textual form.
          name = callee.text;
        }
        if (name) out.calls.push({ name, line: line1(callee) });
        return;
      }
      case 'import_statement': {
        // Mirror the symbol-side import logic so the references index has
        // the same import view as the symbols index (Wave 4 join uses both).
        const sourceNode = n.childForFieldName('source');
        const fromPath = sourceNode
          ? this.stripStringQuotes(sourceNode.text)
          : '';
        for (let i = 0; i < n.namedChildCount; i++) {
          const child = n.namedChild(i);
          if (!child) continue;
          if (child.type === 'import_clause') {
            for (let j = 0; j < child.namedChildCount; j++) {
              const inner = child.namedChild(j);
              if (!inner) continue;
              this.emitImportRef(inner, fromPath, out);
            }
          }
        }
        return;
      }
    }
  }

  protected emitImportRef(
    node: Node,
    fromPath: string,
    out: ReferenceIndex,
  ): void {
    if (node.type === 'identifier') {
      out.imports.push({ name: node.text, from: fromPath, line: line1(node) });
      return;
    }
    if (node.type === 'named_imports') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const spec = node.namedChild(i);
        if (!spec) continue;
        const alias = spec.childForFieldName('alias');
        const name = spec.childForFieldName('name');
        const local = alias ?? name ?? spec.namedChild(0);
        if (local) {
          out.imports.push({
            name: local.text,
            from: fromPath,
            line: line1(local),
          });
        }
      }
      return;
    }
    if (node.type === 'namespace_import') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c && c.type === 'identifier') {
          out.imports.push({
            name: c.text,
            from: fromPath,
            line: line1(c),
          });
          return;
        }
      }
    }
  }

  /** Strip surrounding quotes from a tree-sitter `string` node's text. */
  protected stripStringQuotes(text: string): string {
    if (text.length < 2) return text;
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' || first === "'" || first === '`') && first === last) {
      return text.slice(1, -1);
    }
    return text;
  }
}

// Module-import side effect: register this adapter in the AstFactory so the
// Wave 4 worker can look it up via getAdapter('javascript'). Idempotent on
// re-load (Map.set overwrites cleanly).
registerAdapter('javascript', new JavaScriptAdapter());
