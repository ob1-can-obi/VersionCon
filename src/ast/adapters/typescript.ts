/**
 * Phase 5 Wave 2 (Plan 05-02) — tier-1 TypeScript AST adapter.
 *
 * Extends {@link JavaScriptAdapter} because TS is JS-superset. The base
 * class's walker handles function_declaration / class_declaration /
 * method_definition / lexical+variable_declaration / import_statement /
 * export_statement / call_expression — all of which work identically in
 * TS source. We override {@link collectSymbolFor} to ALSO emit:
 *
 *   - interface_declaration → SymbolIndex.classes
 *     (Rationale: an interface IS the contract a TS consumer depends on.
 *     Treating it as a class for v1 attribution means a renamed interface
 *     correctly fires the "you depend on this" notification.)
 *
 *   - type_alias_declaration → SKIPPED
 *     (Rationale: type aliases don't drive runtime calls — renaming
 *     `type X = string` has no runtime impact, so v1 SC-1 attribution
 *     excludes them.)
 *
 *   - function_signature → SymbolIndex.functions
 *     (Rationale: declaration-only signatures in `.d.ts` files are the
 *     contract a TS consumer depends on, even though there's no
 *     implementation body.)
 *
 * TSX routing: tree-sitter-typescript ships TWO distinct WASM grammars:
 *   - typescript.wasm — parses `.ts`, REJECTS `.tsx` (JSX syntax error)
 *   - tsx.wasm        — parses BOTH `.ts` and `.tsx`
 *
 * We use the TS grammar for `.ts` (smaller, faster) and the TSX grammar
 * for `.tsx`. {@link prepare} loads BOTH parsers up front because Wave 4
 * worker may encounter mixed-extension repos; pre-loading both costs
 * ~3MB of Wasm linear memory once and saves per-file Language.load.
 *
 * Same crash-tolerance contract (T-05-01) and sync-signature contract
 * (T-05-02) as the base adapter. Source-grep test pins zero `throw`
 * statements in this file.
 *
 * Module-import side effect: registers as 'typescript' in the AstFactory.
 */
import type { Node } from 'web-tree-sitter';

import type {
  LanguageId,
  ReferenceIndex,
  SymbolIndex,
} from '../types.js';
import { getParserFor } from '../grammars.js';
import { registerAdapter } from '../AstFactory.js';
import { JavaScriptAdapter } from './javascript.js';

function emptySymbols(): SymbolIndex {
  return {
    functions: [],
    classes: [],
    variables: [],
    imports: [],
    exports: [],
  };
}

function emptyReferences(): ReferenceIndex {
  return { calls: [], reads: [], imports: [] };
}

export class TypeScriptAdapter extends JavaScriptAdapter {
  readonly languageId: LanguageId = 'typescript';

  /**
   * Distinct Parsers for the .ts vs .tsx grammar variants. Pre-loaded by
   * {@link prepare} so the per-file parse path is sync after preparation.
   */
  protected tsParser: typeof this.parser = null;
  protected tsxParser: typeof this.parser = null;

  /**
   * Load both TS + TSX parsers. Either or both pre-warming is supported;
   * idempotent on repeated calls.
   *
   *   await adapter.prepare();             // loads typescript.wasm
   *   await adapter.prepare('foo.tsx');    // loads tsx.wasm
   *
   * The Wave 4 worker should call BOTH at startup so per-file parsing
   * does not pay any async cost.
   */
  async prepare(relativePath?: string): Promise<void> {
    if (relativePath?.endsWith('.tsx')) {
      if (!this.tsxParser) {
        this.tsxParser = await getParserFor('typescript', relativePath);
      }
    } else {
      if (!this.tsParser) {
        this.tsParser = await getParserFor('typescript', undefined);
      }
    }
  }

  /**
   * Pick the right Parser based on the file extension. .tsx routes through
   * the TSX grammar; everything else (including .ts and bare paths) uses
   * the plain TS grammar.
   */
  protected parserFor(relativePath: string): typeof this.parser {
    if (relativePath.endsWith('.tsx')) return this.tsxParser;
    return this.tsParser;
  }

  extractSymbols(source: string, relativePath: string): SymbolIndex {
    const parser = this.parserFor(relativePath);
    if (!parser) return emptySymbols();
    try {
      const tree = parser.parse(source);
      if (!tree) return emptySymbols();
      return this.walkSymbols(tree.rootNode);
    } catch {
      return emptySymbols();
    }
  }

  extractReferences(source: string, relativePath: string): ReferenceIndex {
    const parser = this.parserFor(relativePath);
    if (!parser) return emptyReferences();
    try {
      const tree = parser.parse(source);
      if (!tree) return emptyReferences();
      return this.walkReferences(tree.rootNode);
    } catch {
      return emptyReferences();
    }
  }

  /**
   * Extend the base symbol-emit dispatch with TS-specific node types. We
   * call super() FIRST so JS-superset constructs (function_declaration,
   * class_declaration, lexical_declaration, …) get the same treatment as
   * in the JS adapter — then we layer the TS-only branches on top.
   *
   * Important: NEVER add `case 'function_declaration'` here — super already
   * handles it. Duplicating would emit the symbol twice.
   */
  protected collectSymbolFor(
    n: Node,
    out: SymbolIndex,
    classCtx: string | null,
  ): void {
    super.collectSymbolFor(n, out, classCtx);

    switch (n.type) {
      case 'interface_declaration': {
        const ident = n.childForFieldName('name');
        if (ident) {
          out.classes.push({ name: ident.text, line: ident.startPosition.row + 1 });
        }
        return;
      }
      case 'type_alias_declaration': {
        // v1 scope: types don't drive runtime impact (SC-1). Explicit
        // no-op so a future contributor doesn't accidentally re-enable
        // by adding a fall-through case below.
        return;
      }
      case 'function_signature': {
        // Declaration-only in .d.ts — emit as function so callers of the
        // signature get attribution.
        const ident = n.childForFieldName('name');
        if (ident) {
          out.functions.push({
            name: ident.text,
            line: ident.startPosition.row + 1,
          });
        }
        return;
      }
    }
  }

  /**
   * Override the export visitor to skip exported type_alias_declaration.
   * Base class's collectExports walks namedChildren and emits one export
   * per variable_declarator / function_declaration / class_declaration —
   * type_alias_declaration is not in that allow-list, so v1 scope is
   * already correct by default. We don't need to override anything.
   *
   * (No code change here — kept as documentation. Removing this comment
   * would erase the rationale; future contributors might add a
   * `case 'type_alias_declaration':` to collectExports and silently
   * break SC-1.)
   */
}

// Module-import side effect. Registers under 'typescript' so the Wave 4
// worker's getAdapter('typescript') resolves to this instance regardless
// of whether the file is .ts or .tsx — the TSX routing happens inside
// extractSymbols / extractReferences via parserFor().
registerAdapter('typescript', new TypeScriptAdapter());
