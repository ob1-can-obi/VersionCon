// src/mcp/tools/adviseSync.ts
//
// Phase 8 Plan 08 — MCP tool: advise_sync (composite advisory).
//
// The 7th and FINAL tool in the Phase-8 catalog. Closes AI-04 + SC-4. Fans
// into 4 readers (SyncReader + PresenceReader + DependencyReader +
// ActivityReader) and fuses their signals into a calibrated confidence-
// scored prediction list per RESEARCH §I.2-I.3. The fusion is a PURE
// FUNCTION (fusePredictedConflicts) so it's unit-testable in isolation
// without spinning up an MCP server. The tool handler is a thin wrapper
// that calls the readers + the pure fn.
//
// Payload shape (CONTEXT D-6 LOCKED — byte-identical):
//   { state: { behind: number, ahead: number, dirty: string[], last_sync_at: string | null },
//     predicted_conflicts: Array<{
//       file: string,
//       reason: 'ast-symbol-overlap' | 'file-edit-overlap' | 'lock-held-by-peer',
//       confidence: number,
//       detail: string,
//       peer?: string,
//     }> }
//
// Confidence calibration (RESEARCH §I.3 verbatim — values are LITERAL):
//   0.9 — peer has file open AND user is editing same file (file-edit-overlap)
//   0.7 — peer pushed symbol S, user references S (ast-symbol-overlap)
//   0.6 — peer pushed file F, user has F open dirty (file-edit-overlap)
//   0.5 — user edited symbol S, peer's open file imports S (ast-symbol-overlap)
//   0.2 — behind ≥1 push with no other signal (generic out-of-sync)
//
// target_files (optional) scoping:
//   - undefined → scope to all dirty + recently-edited files (typical case)
//   - []        → state-only with predicted_conflicts: [] (explicit empty)
//   - [paths]   → filter predictions to those paths only
//
// v1 limitations (documented in tool description per critical rules):
//   - No sub-symbol confidence (only symbol/file granularity)
//   - No multi-hop transitive (only 1-hop forward walk; reverseDeps stub
//     returns empty per 08-02-SUMMARY so 2-hop tier is unreachable in v1)
//   - No auto-execution (read-only — never blocks or mutates state)
//
// PresenceInfo field reference: src/types/chat.ts:123 — `activeFilePath: string | null`.
// VERIFIED 2026-05-21 before implementation per plan-checker BLOCKER 2 fix-up.
//
// See:
//   - .planning/phases/08-ai-agent-api-mcp-integration/08-RESEARCH.md
//     §F.3 (description verbatim), §I.2 (composition), §I.3 (calibration table)
//   - .planning/phases/08-ai-agent-api-mcp-integration/08-CONTEXT.md
//     <decisions> item 6 (sync-advice composition — payload shape LOCKED)
//   - .planning/phases/08-ai-agent-api-mcp-integration/08-PATTERNS.md
//     "src/mcp/tools/adviseSync.ts" (composite-tool fan-in pattern)

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerReadOnlyTool } from '../registry.js';
import type {
  SyncReader,
  PresenceReader,
  DependencyReader,
  ActivityReader,
} from '../readers.js';

/** Reason vocabulary for a single PredictedConflict entry (CONTEXT D-6). */
export type ConflictReason =
  | 'ast-symbol-overlap'
  | 'file-edit-overlap'
  | 'lock-held-by-peer';

/** Single predicted-conflict entry (CONTEXT D-6 shape). */
export interface PredictedConflict {
  file: string;
  reason: ConflictReason;
  confidence: number;
  detail: string;
  peer?: string;
}

/** State facts portion of the advise_sync payload (CONTEXT D-6). */
export interface AdviseSyncState {
  behind: number;
  ahead: number;
  dirty: string[];
  last_sync_at: string | null;
}

/** Complete advise_sync payload (CONTEXT D-6 — byte-identical contract). */
export interface AdviseSyncPayload {
  state: AdviseSyncState;
  predicted_conflicts: PredictedConflict[];
}

/**
 * Input to the pure-fn fuser. Narrow shapes (not full reader return types)
 * so this fn can be unit-tested without spinning up the readers. The handler
 * massages reader outputs into these shapes before invoking the fuser.
 */
export interface FusePredictedConflictsInput {
  /** Workspace-relative paths the user has dirty (unsaved/unpushed). */
  dirtyFiles: readonly string[];
  /** Pushes the user is behind by (>0 → generic 0.2 tier eligible). */
  behind: number;
  /**
   * Map of activeFilePath -> peer descriptor. Built from PresenceReader's
   * getPresenceSnapshot() filtered to entries with non-null activeFilePath.
   */
  presenceByFile: ReadonlyMap<string, { memberId: string; displayName?: string }>;
  /**
   * Flattened list of {file, actor} entries from recent peer pushes.
   * Sourced from ActivityReader.getRecentPushes() with PushFileEntry.relativePath
   * flattened out.
   */
  recentPushedFiles: readonly { file: string; actor: string }[];
  /**
   * For each dirty file (key), the symbols + downstream-file references the
   * user's code in that file uses. Built by walking DependencyReader.forwardDeps
   * per dirty file (single-file ad-hoc analysis — bounded by dirty.length).
   */
  userReferences: ReadonlyMap<string, readonly { symbol: string; file: string }[]>;
  /**
   * Symbols that peers pushed recently. Sourced from PushRecord.meta.affectedSymbols
   * (Phase-5 stamp from 05-05). Defensive: missing field means empty list.
   */
  peerPushedSymbols: readonly { symbol: string; actor: string }[];
}

/**
 * PURE FUNCTION: fuse multi-source signals into a deduped, confidence-scored
 * prediction list. RESEARCH §I.3 calibration verbatim.
 *
 * Dedup: keyed on `file|reason|peer` — same-tier duplicates collapse to one
 * entry; different tiers for the same file+peer combo CAN both appear (they
 * are legitimately distinct signals).
 *
 * 0.2 suppression: the generic out-of-sync entry is added ONLY when no other
 * predictions exist AND behind > 0. RESEARCH §I.3: avoid noise when stronger
 * signals are already firing.
 *
 * Side-effect-free; all inputs are `readonly` so the function cannot mutate
 * caller state. Verified by the T-08-03 disposition (pure fn has no I/O,
 * boundary to outside world NOT CROSSED).
 */
export function fusePredictedConflicts(
  args: FusePredictedConflictsInput,
): PredictedConflict[] {
  const out: PredictedConflict[] = [];
  const seen = new Set<string>(); // dedup key: file|reason|peer

  function addUnique(p: PredictedConflict): void {
    const key = `${p.file}|${p.reason}|${p.peer ?? ''}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(p);
  }

  // Tier 0.9 — peer has file open AND user is editing same file.
  for (const dirty of args.dirtyFiles) {
    const peer = args.presenceByFile.get(dirty);
    if (peer) {
      const peerLabel = peer.displayName ?? peer.memberId;
      addUnique({
        file: dirty,
        reason: 'file-edit-overlap',
        confidence: 0.9,
        detail: `${peerLabel} has ${dirty} open while you are editing it`,
        peer: peerLabel,
      });
    }
  }

  // Tier 0.7 — peer pushed a symbol that the user's dirty file references.
  for (const dirty of args.dirtyFiles) {
    const refs = args.userReferences.get(dirty) ?? [];
    for (const ref of refs) {
      if (!ref.symbol) {
        continue;
      }
      const peerPush = args.peerPushedSymbols.find(
        (p): boolean => p.symbol === ref.symbol,
      );
      if (peerPush) {
        addUnique({
          file: dirty,
          reason: 'ast-symbol-overlap',
          confidence: 0.7,
          detail: `${peerPush.actor} pushed a change to symbol ${ref.symbol}; you reference it in ${dirty}`,
          peer: peerPush.actor,
        });
      }
    }
  }

  // Tier 0.6 — peer pushed a file that user has open dirty.
  for (const dirty of args.dirtyFiles) {
    const peerFile = args.recentPushedFiles.find(
      (p): boolean => p.file === dirty,
    );
    if (peerFile) {
      addUnique({
        file: dirty,
        reason: 'file-edit-overlap',
        confidence: 0.6,
        detail: `${peerFile.actor} recently pushed ${dirty}; you have it open and dirty`,
        peer: peerFile.actor,
      });
    }
  }

  // Tier 0.5 — user edited symbol S in their dirty file; peer's open file
  // imports S. Heuristic: for each ref.file in userReferences[dirty], if a
  // peer is present on ref.file, flag it.
  for (const dirty of args.dirtyFiles) {
    const refs = args.userReferences.get(dirty) ?? [];
    for (const ref of refs) {
      if (!ref.file) {
        continue;
      }
      const peerOnRefFile = args.presenceByFile.get(ref.file);
      if (peerOnRefFile) {
        const peerLabel = peerOnRefFile.displayName ?? peerOnRefFile.memberId;
        addUnique({
          file: ref.file,
          reason: 'ast-symbol-overlap',
          confidence: 0.5,
          detail: `You edited ${dirty}; ${peerLabel} has ${ref.file} (which imports from your edits) open`,
          peer: peerLabel,
        });
      }
    }
  }

  // Tier 0.2 — generic out-of-sync (behind > 0) with no other signals.
  // SUPPRESS when stronger predictions exist (avoid noise per RESEARCH §I.3).
  if (out.length === 0 && args.behind > 0) {
    out.push({
      file: '',
      reason: 'file-edit-overlap',
      confidence: 0.2,
      detail: `You are behind by ${args.behind} push${args.behind === 1 ? '' : 'es'}; consider syncing.`,
    });
  }

  return out;
}

/**
 * Register the advise_sync composite tool. Goes through registerReadOnlyTool
 * (Layer 2 runtime gate from 08-03). The handler:
 *   1. Reads SyncReader.getOutOfSyncPaths() for dirty files
 *   2. Reads ActivityReader.getRecentPushes(20) for peer-push history
 *   3. Reads PresenceReader.getPresenceSnapshot() for who-is-on-what-file
 *   4. Walks DependencyReader.forwardDeps per dirty file for AST references
 *   5. Computes `behind` from SyncReader.getLatestPushId() vs latest push id
 *   6. Massages reader outputs into FusePredictedConflictsInput shape
 *   7. Invokes fusePredictedConflicts and packages as AdviseSyncPayload
 *
 * target_files optional input scoping per CONTEXT D-6:
 *   - undefined (typical) → scope to all dirty files
 *   - []                  → state-only with predicted_conflicts: []
 *   - [paths]             → filter dirty files to that subset
 */
export function registerAdviseSync(
  server: McpServer,
  deps: {
    syncReader: SyncReader;
    presenceReader: PresenceReader;
    depReader: DependencyReader;
    activityReader: ActivityReader;
  },
): void {
  registerReadOnlyTool(
    server,
    'advise_sync',
    {
      title: 'Sync Advice',
      // RESEARCH §F.3 verbatim — this description IS the LLM-facing prompt.
      description:
        "Returns the user's current sync state (behind/ahead/dirty) plus a list of predicted " +
        "conflicts with confidence scores, sourced from the active VersionCon session's " +
        "presence tracking and AST dependency graph. Call this before suggesting a push, " +
        "before running code, or when asked 'am I in sync?'. Read-only — never blocks or " +
        "mutates state. Scoped to the local user's view. " +
        "v1 limitations: no sub-symbol confidence, no multi-hop transitive (>1 hop), " +
        "no auto-execution. For deeper queries use query_dependencies / list_dependents directly.",
      inputSchema: {
        target_files: z
          .array(z.string())
          .optional()
          .describe(
            'Optional workspace-relative file paths to scope the conflict prediction. ' +
              'When absent, scopes to all dirty + recently-edited files (typical case). ' +
              'Pass an empty array to get state-only with no predictions.',
          ),
      },
    },
    async ({
      target_files,
    }: {
      target_files?: string[];
    }): Promise<CallToolResult> => {
      // --- Read all four signal sources ---
      const dirty = [...deps.syncReader.getOutOfSyncPaths()];
      const latestPushes = deps.activityReader.getRecentPushes(20);
      const presence = deps.presenceReader.getPresenceSnapshot();
      const latestPushId = deps.syncReader.getLatestPushId();

      // --- Build per-file presence map (PresenceInfo.activeFilePath per
      //     src/types/chat.ts:123) ---
      const presenceByFile = new Map<
        string,
        { memberId: string; displayName?: string }
      >();
      for (const p of presence) {
        if (p.activeFilePath !== null) {
          presenceByFile.set(p.activeFilePath, {
            memberId: p.memberId,
            displayName: p.displayName,
          });
        }
      }

      // --- Flatten recent pushed files (PushRecord.files: PushFileEntry[]
      //     with .relativePath) + collect Phase-5 affected-symbol stamps ---
      const recentPushedFiles: { file: string; actor: string }[] = [];
      const peerPushedSymbols: { symbol: string; actor: string }[] = [];
      for (const push of latestPushes) {
        for (const f of push.files) {
          recentPushedFiles.push({
            file: f.relativePath,
            actor: push.memberDisplayName,
          });
        }
        // Defensive: not all PushRecord shapes carry meta.affectedSymbols
        // (Phase-5 SC-5 stamp; older records lack the field). Each
        // AffectedSymbol has a `name` field per src/ast/types.ts.
        const affected = (push as unknown as {
          meta?: { affectedSymbols?: { name?: string }[] };
        }).meta?.affectedSymbols;
        if (Array.isArray(affected)) {
          for (const s of affected) {
            if (s.name) {
              peerPushedSymbols.push({
                symbol: s.name,
                actor: push.memberDisplayName,
              });
            }
          }
        }
      }

      // --- Build userReferences per dirty file via DependencyReader.forwardDeps.
      //     Single-file ad-hoc per Pitfall 7 — bounded by dirty.length, which
      //     is typically small. ---
      const userReferences = new Map<
        string,
        { symbol: string; file: string }[]
      >();
      for (const f of dirty) {
        const fwd = await deps.depReader.forwardDeps(f, 1);
        const refs: { symbol: string; file: string }[] = [];
        for (const s of fwd.symbols) {
          refs.push({ symbol: s, file: '' });
        }
        for (const fileRef of fwd.files) {
          refs.push({ symbol: '', file: fileRef });
        }
        userReferences.set(f, refs);
      }

      // --- Scope dirty files per target_files arg ---
      let scopedDirty: readonly string[] = dirty;
      const targetFilesExplicitEmpty =
        target_files !== undefined && target_files.length === 0;
      if (target_files !== undefined) {
        if (targetFilesExplicitEmpty) {
          // Explicit empty array → state-only path; predictions suppressed
          scopedDirty = [];
        } else {
          scopedDirty = dirty.filter((f): boolean => target_files.includes(f));
        }
      }

      // --- Compute behind: stale latestPushId iff it lags the head of the
      //     activity log. 0 when no stale signal OR no pushes recorded. ---
      const behindFromPushId =
        latestPushId !== null &&
        latestPushes.length > 0 &&
        latestPushes[0].id !== latestPushId
          ? 1
          : 0;

      // --- Latest sync timestamp (ISO string for LLM-friendliness;
      //     matches get_sync_status convention from 08-06) ---
      const lastPush = latestPushes[0];
      const last_sync_at = lastPush
        ? new Date(lastPush.timestamp).toISOString()
        : null;

      const state: AdviseSyncState = {
        // Empty-scope explicit case → behind=0 (no opinion to express)
        behind: targetFilesExplicitEmpty
          ? 0
          : Math.max(scopedDirty.length, behindFromPushId),
        ahead: 0, // v1 placeholder per CONTEXT D-2; shape stable for future
        dirty: [...scopedDirty],
        last_sync_at,
      };

      // --- Invoke pure-fn fuser (or skip on explicit-empty scope) ---
      const predicted_conflicts: PredictedConflict[] = targetFilesExplicitEmpty
        ? []
        : fusePredictedConflicts({
            dirtyFiles: scopedDirty,
            behind: state.behind,
            presenceByFile,
            recentPushedFiles,
            userReferences,
            peerPushedSymbols,
          });

      const payload: AdviseSyncPayload = { state, predicted_conflicts };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };
    },
  );
}
