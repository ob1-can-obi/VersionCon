/**
 * Phase 5 Wave 3 (Plan 05-03) — C++ adapter (register-but-fallback stub).
 *
 * SC-3 fallback path. v1 of Phase 5 ships C++ support via the FallbackAdapter
 * (line-level / file-level detection per CONF-10). The architecture is wired
 * so dropping a real `tree-sitter-cpp.wasm` + replacing this file with a real
 * `CppAdapter` takes effect in one PR — no changes to AstFactory, the Wave 4
 * worker, or any Wave 5 consumer. The file's existence is the contract.
 *
 * Roadmap: Phase 5.1 promotion. STATE.md "Blockers/Concerns" tracks the
 * tree-sitter-cpp WASM compatibility validation (C++ grammars have ABI
 * gotchas more often than Java); this stub unblocks the Phase 5 ship.
 *
 * Module-load side effect: registerAdapter('cpp', createFallbackAdapter('cpp')).
 * Importing this file (Wave 4 worker does this at boot) fires the
 * registration. After the import, getAdapter('cpp') is non-null and points
 * at a FallbackAdapter — Wave 4 worker has a uniform code path with no
 * `if (cpp) returnNull` branch.
 *
 * Note on extension routing: `detectLanguageFromPath` in AstFactory maps
 * .cc / .cpp / .cxx / .h / .hpp ALL to 'cpp'. The .h tagging is intentional
 * per SC-3 v1 scope — C headers route through the C++ fallback. Mixed-C/C++
 * repos still get file-level analysis correctly.
 */
import { registerAdapter } from '../AstFactory.js';
import { createFallbackAdapter } from './fallback.js';

registerAdapter('cpp', createFallbackAdapter('cpp'));
