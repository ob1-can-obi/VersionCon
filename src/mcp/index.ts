// src/mcp/index.ts
//
// Phase 8 Plan 09 — public barrel export for the MCP subsystem.
//
// This file is the SINGLE import surface consumed by src/extension.ts (08-09
// wiring) and by external tests (mcpActivation.test.ts,
// mcpReadOnlyEnforcementE2E.test.ts). It deliberately re-exports only the
// shapes a caller outside src/mcp/ needs:
//
//   - Lifecycle entry points (start/stop) + their option types
//   - The 08-05 injection-seam implementations (consent, config writer/remover)
//   - The 6 production Reader adapter classes constructed in extension.ts
//   - The McpServerHandle type so callers can hold a reference for shutdown
//
// Internal tools / resources / registry / FakeReaders fixtures are NOT
// re-exported — those are implementation details. If a future caller needs
// one, the import surface stays narrow by going through the file directly
// rather than expanding this barrel.
//
// N-08-01 (no auth import): only intra-mcp re-exports below.
// N-08-04 (no console.*): no logging in a barrel file.
export { startMcpLifecycle, stopMcpLifecycle, type LifecycleOpts } from './lifecycle.js';
export type { McpServerHandle, StartMcpServerOpts } from './server.js';
export type { BuildServerDeps } from './buildServer.js';
export { ensureConsent } from './consent.js';
export { upsertMcpConfig, removeMcpConfig } from './mcpConfig.js';
export { BranchReaderImpl } from './adapters/BranchReaderImpl.js';
export { SyncReaderImpl } from './adapters/SyncReaderImpl.js';
export { ActivityReaderImpl } from './adapters/ActivityReaderImpl.js';
export { ChatReaderImpl } from './adapters/ChatReaderImpl.js';
export { PresenceReaderImpl } from './adapters/PresenceReaderImpl.js';
export { DependencyReaderImpl } from './adapters/DependencyReaderImpl.js';
