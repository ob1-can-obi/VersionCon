/**
 * Phase 5 Wave 3 (Plan 05-03) — Java adapter (register-but-fallback stub).
 *
 * SC-3 fallback path. v1 of Phase 5 ships Java support via the FallbackAdapter
 * (line-level / file-level detection per CONF-10). The architecture is wired
 * so dropping a real `tree-sitter-java.wasm` + replacing this file with a real
 * `JavaAdapter` takes effect in one PR — no changes to AstFactory, the
 * Wave 4 worker, or any Wave 5 consumer. The file's existence is the contract.
 *
 * Roadmap: Phase 5.1 promotion. STATE.md "Blockers/Concerns" tracks the
 * tree-sitter-java + tree-sitter-cpp WASM compatibility validation; this stub
 * unblocks the Phase 5 ship without that validation.
 *
 * Module-load side effect: registerAdapter('java', createFallbackAdapter('java')).
 * Importing this file (Wave 4 worker does this at boot) fires the
 * registration. After the import, getAdapter('java') is non-null and points
 * at a FallbackAdapter — Wave 4 worker has a uniform code path with no
 * `if (java) returnNull` branch.
 *
 * Why register here (in java.ts) rather than in fallback.ts?
 *   - Single-responsibility: fallback.ts is the generic adapter; java.ts is
 *     the binding for the 'java' LanguageId. A future Phase 5.1 swap-in of a
 *     real JavaAdapter replaces THIS file; fallback.ts stays untouched.
 *   - Deleting cpp.ts (or its corresponding adapter) leaves no orphan
 *     registerAdapter('cpp', ...) call in fallback.ts.
 */
import { registerAdapter } from '../AstFactory.js';
import { createFallbackAdapter } from './fallback.js';

registerAdapter('java', createFallbackAdapter('java'));
