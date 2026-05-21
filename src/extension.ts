import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as crypto from 'crypto';
import { WizardPanel } from './ui/WizardPanel.js';
import { JoinPanel } from './ui/JoinPanel.js';
import { SidebarProvider } from './ui/SidebarProvider.js';
import { StatusBarManager } from './ui/StatusBarManager.js';
import { ChatPanel } from './ui/ChatPanel.js';
import { LocalChangesStatusBar } from './ui/LocalChangesStatusBar.js';
import { SessionHistory } from './storage/SessionHistory.js';
import { SessionHost } from './host/SessionHost.js';
import { SessionClient } from './client/SessionClient.js';
import type { ConnectionStatus, HostIdentity } from './types/session.js';
import { FileSystemLayer } from './filesystem/FileSystemLayer.js';
import { BranchTreeProvider } from './ui/BranchTreeProvider.js';
import { BranchListProvider } from './ui/BranchListProvider.js';
import { WorkspaceTreeProvider } from './ui/WorkspaceTreeProvider.js';
import { WorkspaceState } from './filesystem/WorkspaceState.js';
import { BranchManager } from './filesystem/BranchManager.js';
import { BranchPermissions } from './filesystem/BranchPermissions.js';
import { PushHistory } from './filesystem/PushHistory.js';
import { PushService } from './filesystem/PushService.js';
import { SyncTracker } from './filesystem/SyncTracker.js';
import { ChatLog } from './filesystem/ChatLog.js';
import { ReviewStore } from './filesystem/ReviewStore.js';
import { ReviewState } from './state/ReviewState.js';
import { checkRequireReviewGate } from './state/requireReviewGate.js';
import { ReviewPanel } from './ui/ReviewPanel.js';
import { registerInlineCommentsForReview } from './ui/inlineReviewComments.js';
import { AstAnalyzer } from './ast/AstAnalyzer.js';
import { createTimestamp } from './network/protocol.js';
import type { ReviewRequest, ReviewComment, ReviewVoteRecord } from './types/review.js';
import { ActivityLogProvider } from './ui/ActivityLogProvider.js';
import { PresenceTreeProvider } from './ui/PresenceTreeProvider.js';
import { computeFileOverlap, getOpenTabPaths } from './utils/fileOverlap.js';
import { registerGitStyleAliases } from './commands/aliases.js';
import { WorkspaceDiffer } from './services/WorkspaceDiffer.js';
import { GitBridge } from './services/GitBridge.js';
import type { PresenceInfo } from './types/chat.js';
import type { ChatRecord } from './types/chat.js';
// Phase 8 (Plan 08-09): MCP subsystem barrel — single import surface for the
// extension-host wiring. Production injection seams (ensureConsent +
// upsertMcpConfig + removeMcpConfig) come from this module; the 6 Reader
// adapters are constructed inline inside the workspace IIFE once their
// live source classes (BranchManager / SyncTracker / PushHistory / ChatLog /
// SessionHost / AstAnalyzer) are available.
import {
  startMcpLifecycle,
  stopMcpLifecycle,
  type McpServerHandle,
  ensureConsent,
  upsertMcpConfig,
  removeMcpConfig,
  BranchReaderImpl,
  SyncReaderImpl,
  ActivityReaderImpl,
  ChatReaderImpl,
  PresenceReaderImpl,
  DependencyReaderImpl,
} from './mcp/index.js';

// Module-level state for deactivation access
let activeHost: SessionHost | null = null;
let activeClient: SessionClient | null = null;
// Phase 3 (BRANCH-03): module-level reference so the client `branch-created`
// handler (declared in wireClientEvents, outer-scope) can refresh the all-
// branches tree even though the provider itself is constructed inside the
// async IIFE that owns workspace state.
let activeBranchListProvider: BranchListProvider | null = null;
let sidebarProvider: SidebarProvider;
let statusBarManager: StatusBarManager;
// PUSH-09: in-memory sync tracker. Updated on local/remote pushes and on
// sync-response (reconnect). Reset on disconnect.
const syncTracker = new SyncTracker();
// Track the host's member ID for permission checks. Updated by wireHostEvents
// when a session starts. Defaults to 'local-user' (matches the placeholder
// currentMemberId) so the local single-user case always passes host-only checks.
let hostMemberId = 'local-user';
/**
 * Phase 4.1 (Plan 04.1-03): pre-allocated host identity from the wizard.
 * Carries the memberId + displayName + hostAuthSecret triple. Set by
 * wireHostEvents on host-session start, cleared on session-ended. Used
 * by future loopback SessionClient wiring (out of scope for this plan)
 * and as a stable handle to the host's pre-allocated identity for any
 * post-Phase-4.1 features that need it.
 *
 * The hostAuthSecret on this struct is sensitive — it is the gate that
 * elevates a connection to role:'host'. Treat as private to the host
 * process; never log, never serialize to chat-log.json or presence.
 *
 * IMPORTANT (IIFE admin-bypass invariant): the existing `hostMemberId`
 * placeholder at line 49 REMAINS 'local-user'. The IIFE admin gates
 * (currentMemberId !== hostMemberId) rely on both sides being 'local-user'
 * for the host to bypass permission checks on its own local commands. The
 * pre-allocated UUID lives ONLY on `activeHostIdentity.memberId` and on
 * SessionHost.this.hostMemberId (wire-side). The two identities are
 * intentionally decoupled — pinned by plan 04.1-04 Test 11.
 */
let activeHostIdentity: HostIdentity | null = null;
// Phase 3: module-level references so wireHostEvents can wire late-arriving
// services into a freshly-created SessionHost. Set by the async IIFE after
// permissions/pushHistory are loaded.
let activePermissions: { canPushToBranch: (memberId: string, branchName: string) => boolean } | null = null;
// Phase 3 narrow shape kept for host.setPushHistory. Phase 6 Plan 06-04 reads
// the full PushHistory instance via activePushHistoryFull (typed below) so the
// review panel command can look up PushRecord by id.
let activePushHistory: { getLatestRecord: () => { id: string } | undefined } | null = null;
// Phase 6 Plan 06-04: full PushHistory handle (mirrors activePushHistory but
// exposes getRecord/getRecords). Constructed inside the workspace IIFE.
let activePushHistoryFull: PushHistory | null = null;
// Phase 6 Plan 06-04: workspace .versioncon dir resolved once per workspace.
// Used by ReviewPanel.createOrShow + the openReview command to construct
// snapshot URI paths.
let activeVersionconDir: string | null = null;

// Phase 4: provider singletons constructed once in activate() so wire helpers
// (which run after the workspace IIFE) and outer-scope event handlers can both
// reach them.
let presenceTreeProvider: PresenceTreeProvider | null = null;
let activityLogProvider: ActivityLogProvider | null = null;
// Phase 4.3 (SC-5): module-level so the workspace IIFE's FileSystemWatcher
// can refresh the same instance constructed at activate() scope. Singleton
// (one bar per VS Code window).
let localChangesStatusBar: LocalChangesStatusBar | null = null;
// Phase 4: chat unread count + panel-active flag. Plan 04-14 wires the
// `onPanelActivated` callback through ChatPanelRefs to flip
// `chatPanelIsActive`; until that fires this stays false so chat-received
// events always increment unread.
let unreadChatCount = 0;
let chatPanelIsActive = false;
// Phase 4: self identity mirrors so wireClientEvents (module-level) can build
// activity-log entries with a stable isMine flag and so the workspace IIFE can
// flow these into the providers' setSelfMemberId. The IIFE sets the host/local
// values; wireClientEvents updates from auth context when joining as a member.
let currentSelfMemberId = 'local-user';
let currentSelfDisplayName = 'You';
// Phase 4: active branch mirror for presence-update broadcasts and activity-log
// rendering. Updated by the IIFE on init and by versioncon.switchBranch.
let currentBranchName: string | null = null;

// Phase 4 (Plan 04-10): client-side chat record cache. Clients don't read
// chat-log.json directly — the host owns it. The webview gets state-update
// snapshots from this in-memory array, which is reseeded on chat-history
// (join replay) and appended on chat-received.
const clientChatRecords: ChatRecord[] = [];

// Phase 4 (Plan 04-10): module-level connection-status mirror — mirrors the
// client.on('connection-changed') stream so ChatPanel.refs.getConnectionStatus
// can return the live status without holding a SessionClient reference.
let currentConnectionStatus: ConnectionStatus = 'disconnected';

// Phase 4 (Plan 04-10): module-level WorkspaceState reference. The instance
// is constructed inside the workspace IIFE, but openChat (registered in
// activate()) needs to read getChatHiddenBefore() at panel-build time.
// Initialized in the IIFE; remains null when no workspace folder is open.
let workspaceStateRef: WorkspaceState | null = null;

// Phase 4 (Plan 04-11): module-level ChatLog reference for the active branch.
// Created inside the workspace IIFE on init AND on every switchBranch. Wired
// into activeHost via setChatLog(chatLog, branchName) so the host's chat-message
// handler persists arrivals AND so versioncon.manageChat (registered at
// activate scope) can call destructive truncation methods on the host's local
// chat log. Null until the IIFE constructs it; remains null when no workspace
// folder is open.
let activeChatLog: ChatLog | null = null;
// Phase 6 Plan 06-04: per-branch ReviewStore (host-side persistence) +
// module-level ReviewState (client-side cache). The ReviewStore is wired
// into activeHost.setReviewStore on session start + every branch switch.
// The ReviewState is a single in-memory cache shared by every wire-event
// listener (client + host) and read by ReviewPanel.refresh.
let activeReviewStore: ReviewStore | null = null;
let reviewState: ReviewState | null = null;
// Phase 6 Plan 06-05: per-open-review vscode.CommentController + its per-thread
// disposables. Constructed when versioncon.openReview opens a panel for a
// pushId; disposed when the ReviewPanel disposes (via addOwnedDisposable) OR
// when the openReview command opens a different pushId. activeReviewController
// is null when no ReviewPanel is open. activeReviewThreadDisposables tracks
// the per-thread disposables for full-rebuild-on-refresh semantics — when a
// new review-comment lands, we dispose existing threads and re-populate.
let activeReviewController: vscode.CommentController | null = null;
let activeReviewThreadDisposables: vscode.Disposable[] = [];
let activeReviewPushIdForController: string | null = null;

/**
 * Phase 5 Plan 05-05 (SC-5): module-scope mirror of the host-side AstAnalyzer.
 * Constructed by the workspace IIFE once both `activeHost` and `fsLayer` are
 * available (mirrors the activeChatLog wiring pattern). Disposed when the host
 * `session-ended` fires. Null for client-only sessions — clients never run the
 * worker.
 */
let activeAstAnalyzer: AstAnalyzer | null = null;

// Phase 8 (Plan 08-09): module-level handle for the running MCP server so the
// extension's deactivate() can call stopMcpLifecycle on it. Set in the
// startMcpLifecycle().then(...) inside the workspace IIFE once the bind
// completes (the handle is null until the MCP server has bound a port).
// Cleared on deactivate(). Mirrors the activeAstAnalyzer null-when-absent
// pattern above.
let runningMcpHandle: McpServerHandle | null = null;

// Phase 8 (Plan 08-09): workspace folder path snapshot captured at MCP startup
// for the deactivate-time removeMcpConfig cleanup. We snapshot HERE (not at
// deactivate time) because vscode.workspace.workspaceFolders may be cleared
// during shutdown sequencing; the snapshot guarantees we know which folder
// to clean up regardless of teardown order.
let mcpWorkspaceFolderPath: string | null = null;

// Phase 8 (Plan 08-09): module-level singleton OutputChannel for the MCP
// subsystem. Lazily created via getMcpOutputChannel() on first log line so
// the channel only exists when MCP startup actually runs. Mirrors the
// getGitBridgeOutputChannel + getDeepLinkOutputChannel lifecycle (idempotent
// push to context.subscriptions; channel disposes with the extension).
let mcpOutputChannel: vscode.OutputChannel | null = null;
let mcpChannelPushedToSubs = false;

// Phase 8 (Plan 08-09): startup-idempotency guard. The workspace IIFE inside
// activate() runs once per VS Code window, but the MCP startup block lives
// AFTER all the session-host/branch/push/chat constructions so it lands
// reachably even if a session never starts. This flag prevents duplicate
// startMcpLifecycle calls if the IIFE wiring shape ever changes (e.g. a
// future refactor moves the block under a session-start callback).
let mcpStartupAttempted = false;

/**
 * Phase 8 (Plan 08-09) — lazy singleton MCP OutputChannel factory. Channel
 * name 'VersionCon: MCP' is the canonical user-visible label (matches plan
 * artifact). Channel is registered into context.subscriptions on first
 * construction so it disposes with the extension. Subsequent calls return
 * the same instance.
 *
 * Mirrors getGitBridgeOutputChannel (extension.ts:189) and
 * getDeepLinkOutputChannel (extension.ts:210) byte-for-byte structure.
 */
function getMcpOutputChannel(
  context: vscode.ExtensionContext,
): vscode.OutputChannel {
  if (!mcpOutputChannel) {
    mcpOutputChannel = vscode.window.createOutputChannel('VersionCon: MCP');
  }
  if (!mcpChannelPushedToSubs) {
    context.subscriptions.push(mcpOutputChannel);
    mcpChannelPushedToSubs = true;
  }
  return mcpOutputChannel;
}

// Phase 4.3 Wave 4 (Plan 04.3-04): dedicated Output channel for the cloud
// bridge commands (versioncon.exportToGitRemote / versioncon.importFromGitRemote).
// Lazily created on first use via getGitBridgeOutputChannel() so the channel
// only exists once the user actually invokes a cloud command; disposed with
// the extension via context.subscriptions.push at construction time.
let gitBridgeOutputChannel: vscode.OutputChannel | null = null;
let gitBridgeChannelPushedToSubs = false;

/**
 * Lazily construct (or return) the singleton Output channel named exactly
 * 'VersionCon: Git Bridge' per Phase 4.3 SPEC. Registered into
 * context.subscriptions on first construction so it disposes with the
 * extension. Subsequent calls return the same instance.
 */
function getGitBridgeOutputChannel(
  context: vscode.ExtensionContext,
): vscode.OutputChannel {
  if (!gitBridgeOutputChannel) {
    gitBridgeOutputChannel = vscode.window.createOutputChannel('VersionCon: Git Bridge');
  }
  if (!gitBridgeChannelPushedToSubs) {
    context.subscriptions.push(gitBridgeOutputChannel);
    gitBridgeChannelPushedToSubs = true;
  }
  return gitBridgeOutputChannel;
}

// Phase 7 (Plan 07-06): dedicated Output channel for the vscode:// deep-link
// UriHandler. Lazily created on first deep-link arrival via
// getDeepLinkOutputChannel() and disposed with the extension via
// context.subscriptions. Mirrors the getGitBridgeOutputChannel lifecycle
// pattern above (single canonical channel name; idempotent push to subs).
let deepLinkOutputChannel: vscode.OutputChannel | null = null;
let deepLinkChannelPushedToSubs = false;

function getDeepLinkOutputChannel(
  context: vscode.ExtensionContext,
): vscode.OutputChannel {
  if (!deepLinkOutputChannel) {
    deepLinkOutputChannel = vscode.window.createOutputChannel('VersionCon: Deep Links');
  }
  if (!deepLinkChannelPushedToSubs) {
    context.subscriptions.push(deepLinkOutputChannel);
    deepLinkChannelPushedToSubs = true;
  }
  return deepLinkOutputChannel;
}

/**
 * Phase 7 (Plan 07-06): UriHandler for vscode://versioncon.versioncon/join?...
 * deep-links emitted by the Wizard share screen (Plan 07-05).
 *
 * Security contract (LOCKED — corresponds to the threat model in 07-06-PLAN.md):
 *
 *  - T-07-10 (Spoofing / Social-Engineering): REQUIRES a confirmation prompt
 *    via vscode.window.showInformationMessage BEFORE any JoinPanel open or
 *    network call. NO trust-list, NO bypass flag.
 *
 *  - T-07-10a (XSS): the URI layer passes decoded values verbatim — escape
 *    responsibility is owned by the webview render layer
 *    (join.js:escapeHtml). The information-message dialog renders text-only,
 *    so passing untrusted strings to its `message` parameter is safe.
 *
 *  - T-07-10b (Information Disclosure): the OutputChannel never logs the
 *    invite `code` value — log lines include `relay=` and `session=` only.
 *
 *  - T-07-10c (Phase 4.1 invariant): displayName is NEVER extracted from a
 *    URI query param. The JoinPrefill struct (defined in JoinPanel.ts) has
 *    no displayName field. User MUST type it in the panel after arrival.
 *
 * Validation order: path → required-params → wss-scheme → confirmation
 * prompt. The user is never asked to confirm an obviously-malformed link.
 */
export class VersionConUriHandler implements vscode.UriHandler {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sessionHistory: SessionHistory,
    private readonly onConnected: (client: SessionClient) => void,
  ) {}

  async handleUri(uri: vscode.Uri): Promise<void> {
    const channel = getDeepLinkOutputChannel(this.context);
    const ts = new Date().toISOString();

    if (uri.path !== '/join') {
      channel.appendLine(`[${ts}] Unsupported deep-link path: ${uri.path}`);
      return;
    }

    const params = new URLSearchParams(uri.query);
    const relay = params.get('relay');
    const session = params.get('session');
    const code = params.get('code') ?? '';
    // Phase 7 plan 07-14 (MD-03 Option A closure): parse the bootstrap JWT
    // from the deep-link's `bt` query param. URL-decoded automatically by
    // URLSearchParams.get(). Empty string when absent (LAN-mode deep-link OR
    // legacy pre-07-13 cloud deep-link). NEVER logged in plaintext — the log
    // line below uses literal `bt=<redacted>` to redact the value.
    //
    // T-07-20 mitigation (HIGH severity): the bootstrap JWT, if leaked into
    // VS Code's session log, would expose a 15-minute window for replay.
    // Redaction at the log boundary prevents this leak even in
    // operator-pulled diagnostics.
    const bt = params.get('bt') ?? '';

    if (!relay) {
      channel.appendLine(`[${ts}] Deep-link missing required parameter: relay`);
      return;
    }
    if (!session) {
      channel.appendLine(`[${ts}] Deep-link missing required parameter: session`);
      return;
    }
    if (!relay.startsWith('wss://')) {
      // Log the scheme (NOT the full relay value — keeps the log signal
      // bounded) and surface a user-visible error toast. Note: validation
      // precedes the confirmation prompt so the user is never asked to
      // "Join" an obviously-malicious URL.
      const scheme = relay.split(':')[0] ?? '<unknown>';
      channel.appendLine(`[${ts}] Deep-link rejected: relay must use wss:// (got ${scheme}://)`);
      await vscode.window.showErrorMessage(
        'Invalid invite link — relay must use wss://.',
      );
      return;
    }

    // T-07-10 mitigation — REQUIRED confirmation prompt before any panel open
    // or network call. UI-SPEC literal copy ("Join VersionCon session? You've
    // been invited to join a cloud session at <relay>.").
    const choice = await vscode.window.showInformationMessage(
      `Join VersionCon session? You've been invited to join a cloud session at ${relay}.`,
      'Join',
      'Cancel',
    );

    if (choice !== 'Join') {
      // Silent cancellation per UI-SPEC §Reconnect Progress Copy ("no toast on
      // cancel"). Only an OutputChannel breadcrumb is left for diagnostics.
      channel.appendLine(`[${ts}] Deep-link declined by user (choice=${choice ?? 'dismissed'})`);
      return;
    }

    // T-07-10b: log relay + session but NEVER the invite code value.
    // T-07-20 (plan 07-14, HIGH): when the deep-link carries `bt`, the log
    // line MUST include the literal `bt=<redacted>` token so operators have
    // a breadcrumb that a bootstrap JWT was present WITHOUT exposing the
    // JWT value itself. When `bt` is absent (LAN deep-link OR legacy cloud
    // deep-link), the literal is omitted entirely — keeps the LAN log
    // byte-identical to pre-07-14.
    const btLog = bt.length > 0 ? ', bt=<redacted>' : '';
    channel.appendLine(`[${ts}] Deep-link accepted — opening JoinPanel prefilled (relay=${relay}, session=${session}${btLog})`);

    // T-07-10c: JoinPrefill struct has NO displayName field. The joiner must
    // type their displayName in the panel after it opens, preserving the
    // Phase 4.1 "displayName is always self-attested" invariant.
    await JoinPanel.openPrefilled(
      this.context,
      this.sessionHistory,
      this.onConnected,
      { mode: 'cloud', relayUrl: relay, sessionId: session, inviteCode: code, bootstrapToken: bt },
    );
  }
}

/**
 * Format the CONF-07 toast string per UI-SPEC §6.1 (locked literals):
 *   - 1 file overlap: `{name} pushed 1 file — affects: {fileBasename}: '{msg}'`
 *   - 2-3 overlap:    `{name} pushed N file(s) — affects: a, b, c: '{msg}'`
 *   - >3 overlap:     `{name} pushed N file(s) — affects: a, b, +(N-2) more: '{msg}'`
 *   - empty msg → trailing `: '{msg}'` is omitted entirely.
 *
 * Pure helper — exported only for unit-testability shape (no external import yet).
 */
/**
 * Phase 4.3 SC-1: hide `.versioncon/` from VS Code's native File Explorer by
 * merging `{ ".versioncon": true }` into `<workspace>/.vscode/settings.json`
 * under `files.exclude`. T-04.3-01 mitigation: NEVER overwrite the whole file —
 * read existing JSON, deep-merge under files.exclude only, write back.
 *
 * Gated by `context.workspaceState.get('versioncon.filesExcludeInjected')` so
 * we run at most once per workspace. If the user manually sets the key (true
 * OR false) themselves, we do NOT touch it on subsequent activations.
 *
 * Defense-in-depth: malformed-JSON errors are swallowed and treated as empty
 * existing-settings; the helper never propagates exceptions to the caller.
 * The IIFE admin-bypass invariant is unaffected — this code path runs BEFORE
 * the workspace IIFE and only touches `.vscode/settings.json`.
 *
 * Exported (rather than module-private) so the regression suite in
 * `src/test/suite/filesExclude.test.ts` can exercise the helper directly
 * against a tmpdir-backed `vscode.ExtensionContext`-shaped fake. Tests in
 * this repo already reach into internal helpers (see chatLog.test.ts for
 * prior art).
 *
 * @internal — public only for testability.
 */
export async function ensureVersionconExcluded(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (context.workspaceState.get<boolean>('versioncon.filesExcludeInjected')) {
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    // No folder open — defer until one is opened. Do NOT set the flag yet.
    return;
  }
  const settingsPath = path.join(folder.uri.fsPath, '.vscode', 'settings.json');
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fsPromises.readFile(settingsPath, 'utf-8');
    existing = JSON.parse(raw) as Record<string, unknown>;
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      // Defensive: a top-level JSON array or null is not a valid settings
      // shape; treat as empty rather than letting the assignment below blow up.
      existing = {};
    }
  } catch {
    /* file missing or malformed — treat as empty, do NOT propagate */
  }
  const filesExclude =
    (existing['files.exclude'] as Record<string, unknown> | undefined) ?? {};
  // If the user already has an opinion (true OR false), respect it and just
  // set the workspaceState flag so we never revisit on subsequent activations.
  if (Object.prototype.hasOwnProperty.call(filesExclude, '.versioncon')) {
    await context.workspaceState.update('versioncon.filesExcludeInjected', true);
    return;
  }
  filesExclude['.versioncon'] = true;
  existing['files.exclude'] = filesExclude;
  await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsPromises.writeFile(settingsPath, JSON.stringify(existing, null, 2), 'utf-8');
  await context.workspaceState.update('versioncon.filesExcludeInjected', true);
}

function formatPushToast(name: string, overlapping: string[], message: string): string {
  const N = overlapping.length;
  const msgSuffix = message ? `: '${message}'` : '';
  if (N === 1) {
    return `${name} pushed 1 file — affects: ${path.basename(overlapping[0])}${msgSuffix}`;
  }
  if (N <= 3) {
    return `${name} pushed ${N} file(s) — affects: ${overlapping.map(f => path.basename(f)).join(', ')}${msgSuffix}`;
  }
  const firstTwo = overlapping.slice(0, 2).map(f => path.basename(f)).join(', ');
  return `${name} pushed ${N} file(s) — affects: ${firstTwo}, +${N - 2} more${msgSuffix}`;
}

/**
 * Plan 04-10: host-only echo of the host's own chat message back into its
 * own ChatPanel. The host does not receive its own broadcast over the wire
 * (it IS the broadcaster), so without this echo the host would type a
 * message and never see it appear locally. Records are stored in the
 * shared clientChatRecords cache so subsequent setHistory snapshots include
 * them. Skips the unread-counter increment because the host literally
 * just typed it.
 */
function dispatchChatReceivedLocally(record: ChatRecord): void {
  clientChatRecords.push(record);
  ChatPanel.currentPanel?.postChatMessage(record);
}

/**
 * Phase 5 Plan 05-05 (SC-5): patch a previously-received chat record's meta
 * with AST-derived affectedSymbols + unsupportedLanguages, then forward the
 * patch to the ChatPanel webview and ActivityLogProvider so the row re-renders
 * with the smart push summary ("affects 2 of your symbols: …").
 *
 * Routing is identical for the host echo (via SessionHost emit) and the
 * member wire path (via SessionClient emit) — both call this helper. No-op
 * when the recordId is unknown locally (e.g. amend arrived after a
 * chat-cleared truncation; or the original chat-message was never received,
 * which is the T-05-06 accepted-risk wire-ordering race).
 */
function applyAmendLocally(
  recordId: string,
  affectedSymbols: import('./ast/types.js').AffectedSymbol[],
  unsupportedLanguages: string[],
): void {
  // Patch the in-memory chat record cache so subsequent setHistory snapshots
  // include the upgraded meta.
  const idx = clientChatRecords.findIndex(r => r.id === recordId);
  if (idx >= 0) {
    const existing = clientChatRecords[idx].meta ?? {};
    clientChatRecords[idx] = {
      ...clientChatRecords[idx],
      meta: { ...existing, affectedSymbols, unsupportedLanguages },
    };
  }
  // Forward to the webview so its in-state record + rendered row update.
  ChatPanel.currentPanel?.applyAmend(recordId, affectedSymbols, unsupportedLanguages);
  // Forward to the activity tree so the sidebar label upgrades.
  activityLogProvider?.applyAmend(recordId, affectedSymbols, unsupportedLanguages);
}

/**
 * Plan 04-11: Markdown formatter for the member-side chat export path. Mirrors
 * ChatLog.exportToFile's markdown layout exactly so a host export and a member
 * export of the same record set produce identical .md output:
 *  - System events render as a two-line block-quote.
 *  - User messages render as an H3 heading + body.
 * Records are joined by `\n\n---\n\n` at the call site.
 */
function formatChatRecordAsMarkdown(r: ChatRecord): string {
  const tsIso = new Date(r.timestamp).toISOString();
  if (r.kind === 'system') {
    return `> _${r.memberDisplayName} · ${tsIso}_\n> ${r.body}`;
  }
  return `### ${r.memberDisplayName} · ${tsIso}\n\n${r.body}`;
}

/** Re-evaluate the `versioncon.activityLog.empty` context key after every entry mutation. */
function updateActivityContext(): void {
  const empty = (activityLogProvider?.getEntries().length ?? 0) === 0;
  void vscode.commands.executeCommand('setContext', 'versioncon.activityLog.empty', empty);
}

/** Re-evaluate the `versioncon.presence.alone` context key after presence mutations. */
function updatePresenceContext(): void {
  const others = (presenceTreeProvider?.getEntries() ?? [])
    .filter(e => e.memberId !== currentSelfMemberId);
  void vscode.commands.executeCommand('setContext', 'versioncon.presence.alone', others.length === 0);
}

/**
 * Phase 6 Plan 06-04: refresh the open ReviewPanel (if any) from the current
 * module-level reviewState + the matching PushRecord (looked up via
 * activePushHistoryFull, which may be null on first activation). No-op if no
 * panel is open OR no reviewState is wired.
 */
function refreshReviewPanelIfOpen(): void {
  const panel = ReviewPanel.currentPanel;
  if (!panel || !reviewState) return;
  const push = activePushHistoryFull?.getRecord(panel.scopedPushId);
  panel.refresh(reviewState, push);
}

/**
 * Phase 6 Plan 06-05: rebuild the inline CommentController threads from the
 * current review snapshot. Full rebuild on every refresh — disposes existing
 * thread disposables, then re-registers via registerInlineCommentsForReview.
 * Bounded by host's 500-comment-per-review cap (Plan 06-02), so the cost is
 * negligible. No-op when no controller is active OR no panel matches.
 */
function rebuildInlineReviewComments(): void {
  const panel = ReviewPanel.currentPanel;
  if (!panel || !activeReviewController || !reviewState) return;
  if (activeReviewPushIdForController !== panel.scopedPushId) return;
  const review =
    reviewState.getActiveReviewForPush(panel.scopedPushId)
      ?? reviewState.getReviewByPushId(panel.scopedPushId);
  if (!review) return;
  const branch = currentBranchName ?? review.branch;
  if (!activeVersionconDir) return;
  const branchDir = path.join(activeVersionconDir, 'branches', branch);
  // Dispose prior threads before re-populating.
  for (const d of activeReviewThreadDisposables) {
    try { d.dispose(); } catch { /* ignore */ }
  }
  activeReviewThreadDisposables = registerInlineCommentsForReview(
    activeReviewController,
    review,
    branchDir,
    (filePath, line, body) => {
      // Reuse the existing onCommentRequested wire path so replies travel the
      // same identity-override + rate-limit + 500-cap pipeline as the panel
      // composer (Plan 06-02 OWNER).
      const callbacks = buildReviewPanelCallbacks();
      callbacks.onCommentRequested(review.id, filePath, line, body);
    },
  );
}

/**
 * Phase 6 Plan 06-04: ReviewPanel routing callbacks. Routes vote/comment/
 * resolve actions to either the active host (via handleLocalReview* helpers)
 * or the active client (via SessionClient.sendMessage). Host-trusted
 * identity override applies on both paths (T-06-01 mitigation).
 */
function buildReviewPanelCallbacks(): import('./ui/ReviewPanel.js').ReviewPanelCallbacks {
  return {
    onVoteRequested: (reviewId, vote) => {
      const frame = {
        type: 'review-vote' as const,
        reviewId,
        // Webview-originated frames carry EMPTY reviewerMemberId/displayName
        // — the host (Plan 06-02 OWNER) overrides at relay. T-06-01.
        vote: {
          reviewerMemberId: '',
          reviewerDisplayName: '',
          vote,
          votedAt: 0,
        } as ReviewVoteRecord,
        timestamp: 0,
      };
      if (activeHost) {
        void activeHost.handleLocalReviewVote(frame);
      } else if (activeClient) {
        activeClient.sendMessage(frame);
      } else {
        void vscode.window.showWarningMessage(
          'No active session — start or join one to vote.',
        );
      }
    },
    onCommentRequested: (reviewId, filePath, line, body) => {
      const comment: ReviewComment = {
        id: crypto.randomUUID(),
        reviewId,
        authorMemberId: '',          // host overrides — T-06-01
        authorDisplayName: '',       // host overrides — T-06-01
        filePath,
        line,
        body,
        createdAt: 0,                // host stamps — T-06-01
      };
      const frame = {
        type: 'review-comment' as const,
        reviewId,
        comment,
        timestamp: 0,
      };
      if (activeHost) {
        void activeHost.handleLocalReviewComment(frame);
      } else if (activeClient) {
        activeClient.sendMessage(frame);
      } else {
        void vscode.window.showWarningMessage(
          'No active session — start or join one to comment.',
        );
      }
    },
    onResolveRequested: (reviewId, resolvedReason) => {
      const frame = {
        type: 'review-resolved' as const,
        reviewId,
        resolvedBy: '',              // host overrides — T-06-01
        resolvedReason,
        timestamp: 0,
      };
      if (activeHost) {
        void activeHost.handleLocalReviewResolved(frame);
      } else if (activeClient) {
        activeClient.sendMessage(frame);
      } else {
        void vscode.window.showWarningMessage(
          'No active session — start or join one to resolve.',
        );
      }
    },
    getSelfMemberId: () => currentSelfMemberId,
    getHostMemberId: () => hostMemberId,
  };
}

/**
 * Phase 6 Plan 06-04: implementation for the versioncon.openReview command.
 * Resolves the active branch + ReviewState + PushHistory, then either opens
 * the panel for the supplied pushId OR shows a QuickPick of open reviews +
 * "Open a new review on a recent push" options. If the user picks a push
 * that has no existing ReviewRequest, this routes a fresh review-opened
 * frame through the active session (host or client path).
 */
async function openReviewCommandImpl(
  context: vscode.ExtensionContext,
  argPushId: string | null,
): Promise<void> {
  const rs = reviewState;
  if (!rs) {
    void vscode.window.showErrorMessage(
      'VersionCon: review state not initialized — open a workspace folder first.',
    );
    return;
  }
  const versionconDir = activeVersionconDir;
  if (!versionconDir) {
    void vscode.window.showErrorMessage(
      'VersionCon: open a workspace folder before opening a review.',
    );
    return;
  }
  const branch = currentBranchName ?? 'main';
  const pushHistory = activePushHistoryFull;

  // Resolve target pushId.
  interface ReviewPickItem extends vscode.QuickPickItem {
    pickKind: 'existing' | 'open-new';
    pushIdValue: string;
  }
  let targetPushId: string | null = argPushId;
  if (!targetPushId) {
    const items: ReviewPickItem[] = [];
    for (const r of rs.getReviewsForBranch(branch)) {
      if (r.status === 'resolved' || r.status === 'abandoned') continue;
      items.push({
        pickKind: 'existing',
        pushIdValue: r.pushId,
        label: `$(comment-discussion) ${r.authorDisplayName} — push ${r.pushId.substring(0, 7)}`,
        description: r.status,
      });
    }
    if (pushHistory) {
      for (const p of pushHistory.getRecords()) {
        if (p.branch !== branch || p.memberId !== currentSelfMemberId) continue;
        if (rs.getActiveReviewForPush(p.id)) continue;
        items.push({
          pickKind: 'open-new',
          pushIdValue: p.id,
          label: `$(add) Open a review on push ${p.id.substring(0, 7)}`,
          description: `${p.files.length} files`,
          detail: p.message,
        });
      }
    }
    if (items.length === 0) {
      void vscode.window.showInformationMessage(
        'No open reviews on this branch, and you have no pushes available to start a review on.',
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a review to open, or start a new one on your push',
    });
    if (!picked) return;
    if (picked.pickKind === 'open-new') {
      await routeOpenReviewFor(picked.pushIdValue, branch);
    }
    targetPushId = picked.pushIdValue;
  } else if (!rs.getReviewByPushId(targetPushId)) {
    // Direct pushId arg but no review exists yet — gate to author + offer to open.
    const record = pushHistory?.getRecord(targetPushId);
    if (record && record.memberId === currentSelfMemberId) {
      const confirm = await vscode.window.showInformationMessage(
        `Open a review on push ${targetPushId.substring(0, 7)}?`,
        'Open Review',
        'Cancel',
      );
      if (confirm !== 'Open Review') return;
      await routeOpenReviewFor(targetPushId, branch);
    } else {
      void vscode.window.showWarningMessage(
        'No review exists for that push yet, and only the push author can open one.',
      );
      return;
    }
  }

  if (!targetPushId) return;
  const pushRecord = pushHistory?.getRecord(targetPushId);

  const panel = ReviewPanel.createOrShow(
    context,
    targetPushId,
    versionconDir,
    buildReviewPanelCallbacks(),
  );
  panel.setScopedBranch(branch);
  panel.refresh(rs, pushRecord);

  // Phase 6 Plan 06-05 — construct + attach the per-review CommentController
  // alongside the panel. Disposed via panel.addOwnedDisposable so the inline
  // gutter UI tears down when the user closes the review.
  // If a controller is already active for a different pushId, dispose it
  // (singleton invariant mirrors ReviewPanel.currentPanel).
  if (
    activeReviewController
    && activeReviewPushIdForController !== targetPushId
  ) {
    for (const d of activeReviewThreadDisposables) {
      try { d.dispose(); } catch { /* ignore */ }
    }
    activeReviewThreadDisposables = [];
    try { activeReviewController.dispose(); } catch { /* ignore */ }
    activeReviewController = null;
    activeReviewPushIdForController = null;
  }
  if (!activeReviewController) {
    activeReviewController = vscode.comments.createCommentController(
      `versioncon.review.${targetPushId}`,
      `Review: push ${targetPushId.substring(0, 7)}`,
    );
    activeReviewPushIdForController = targetPushId;
    // Owned by the panel — closing the panel disposes the controller too.
    // Wrap in a synthetic Disposable that ALSO clears the module-level
    // refs so a subsequent openReview can construct a fresh controller.
    panel.addOwnedDisposable({
      dispose: () => {
        for (const d of activeReviewThreadDisposables) {
          try { d.dispose(); } catch { /* ignore */ }
        }
        activeReviewThreadDisposables = [];
        try { activeReviewController?.dispose(); } catch { /* ignore */ }
        activeReviewController = null;
        activeReviewPushIdForController = null;
      },
    });
  }
  rebuildInlineReviewComments();
}

/**
 * Route a fresh review-opened wire frame through the active session for the
 * given pushId. Best-effort: if no session is active, surface a warning and
 * return. The host (Plan 06-02 OWNER) re-validates author identity at relay.
 */
async function routeOpenReviewFor(pushId: string, branch: string): Promise<void> {
  const review: ReviewRequest = {
    id: crypto.randomUUID(),
    pushId,
    branch,
    authorMemberId: '',           // host overrides — T-06-01
    authorDisplayName: '',        // host overrides — T-06-01
    openedAt: 0,                  // host stamps — T-06-01
    status: 'open',
    votes: [],
    comments: [],
  };
  const frame = { type: 'review-opened' as const, review, timestamp: 0 };
  if (activeHost) {
    await activeHost.handleLocalReviewOpen(frame);
  } else if (activeClient) {
    activeClient.sendMessage(frame);
  } else {
    void vscode.window.showWarningMessage(
      'No active session — start or join one to open a review.',
    );
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // --- Core services ---
  const sessionHistory = new SessionHistory(context);
  statusBarManager = new StatusBarManager();
  sidebarProvider = new SidebarProvider(context.extensionUri, context);

  // --- Register sidebar view provider ---
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('versioncon.sidebar', sidebarProvider),
  );
  context.subscriptions.push(statusBarManager);

  // --- Phase 4: providers for presence + activity-log views ---
  presenceTreeProvider = new PresenceTreeProvider();
  activityLogProvider = new ActivityLogProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('versioncon.presence', presenceTreeProvider),
    vscode.window.registerTreeDataProvider('versioncon.activityLog', activityLogProvider),
  );

  // --- Phase 6 Plan 06-04: module-level ReviewState cache. Constructed once
  // per extension activation; fed by both wireClientEvents (joiner path) and
  // wireHostEvents (host path) when their respective ReviewState-touching
  // wire frames arrive. Read by ReviewPanel.refresh on every review-* event.
  reviewState = new ReviewState();

  // --- Phase 4.3 (SC-5): local-changes status-bar indicator ---
  // Constructed BEFORE the workspace IIFE so the watcher wiring inside the
  // IIFE can reference the module-level singleton without nullability noise.
  // Lifecycle: VS Code disposes it on extension deactivate via
  // context.subscriptions.
  localChangesStatusBar = new LocalChangesStatusBar();
  context.subscriptions.push(localChangesStatusBar);

  // First activation in this workspace: nudge the Team Sync container to the
  // secondary (right) sidebar. VS Code does not let extensions declare an
  // aux-bar default in package.json — viewsContainers only accepts
  // 'activitybar' or 'panel'. Best-effort: invoke moveViewToAuxiliaryBar
  // once, gated by workspaceState so a later drag back to the primary bar
  // is sticky on subsequent reloads. Wrapped in try/catch because the
  // command id is not part of the stable public API and may rename or be
  // unavailable on older VS Code; failure must not break activation.
  if (!context.workspaceState.get<boolean>('versioncon.movedToAux')) {
    setTimeout(() => {
      void (async () => {
        try {
          await vscode.commands.executeCommand(
            'workbench.action.moveViewToAuxiliaryBar',
            { viewId: 'workbench.view.extension.versioncon' },
          );
        } catch (err) {
          console.error('[versioncon] moveViewToAuxiliaryBar failed', err);
        }
        await context.workspaceState.update('versioncon.movedToAux', true);
      })();
    }, 0);
  }

  // --- Phase 4.3 (SC-1, T-04.3-01 mitigation): hide .versioncon/ from File
  // Explorer by merging { ".versioncon": true } into .vscode/settings.json.
  // Fire-and-forget so activation never blocks on disk I/O. The helper itself
  // swallows malformed-JSON / read errors; the outer catch is defense-in-depth
  // for write/mkdir failures so a permission error never breaks activation.
  void ensureVersionconExcluded(context).catch(err => {
    console.error('[versioncon] files.exclude injection failed', err);
  });

  // --- Phase 4: starting context keys for viewsWelcome `when` clauses ---
  void vscode.commands.executeCommand('setContext', 'versioncon.connected', false);
  void vscode.commands.executeCommand('setContext', 'versioncon.activityLog.empty', true);
  void vscode.commands.executeCommand('setContext', 'versioncon.presence.alone', true);

  // --- Phase 4: refresh commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('versioncon.refreshPresence', () => {
      presenceTreeProvider?.refresh();
    }),
    vscode.commands.registerCommand('versioncon.refreshActivityLog', () => {
      activityLogProvider?.refresh();
    }),
  );

  // --- Phase 4.3 (SC-2): git-style command aliases (pure pass-throughs) ---
  // Adds versioncon.cmd.push/pull/checkout/branch/log/diff/merge as thin
  // wrappers calling executeCommand on the canonical handler. One site, one
  // call — all routing lives in src/commands/aliases.ts. DO NOT add new
  // behavior to the aliases; behavior changes happen in the canonical command.
  registerGitStyleAliases(context);

  // --- Phase 4: activity-tree row click dispatcher (UI-SPEC §3.2) ---
  // ActivityLogProvider declares `versioncon.activityLog.openEntry` as the click
  // command for push/revert/branch entries (chat-unread routes to openChat itself).
  // Dispatch per kind: push/revert → push history modal; branch-create → switchBranch
  // picker; chat-unread is handled directly by the provider.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'versioncon.activityLog.openEntry',
      (entry: import('./ui/ActivityLogProvider.js').ActivityEntry) => {
        if (!entry) return;
        switch (entry.kind) {
          case 'push':
          case 'revert':
            void vscode.commands.executeCommand('versioncon.showPushHistory');
            break;
          case 'branch-created':
            void vscode.commands.executeCommand('versioncon.switchBranch');
            break;
          case 'chat-unread':
            void vscode.commands.executeCommand('versioncon.openChat');
            break;
        }
      },
    ),
  );

  // --- Phase 4 (Plan 04-10): chat panel open command + manage-chat stub ---
  // versioncon.openChat creates or reveals the singleton ChatPanel. Refs
  // bundle the live module-state at panel-build time so the panel always
  // sees fresh closures (sendChatMessage routing depends on host-vs-client).
  context.subscriptions.push(
    vscode.commands.registerCommand('versioncon.openChat', () => {
      if (!activeClient && !activeHost) {
        void vscode.window.showWarningMessage(
          'Not connected. Host or join a session first.',
        );
        return;
      }
      if (!workspaceStateRef) {
        void vscode.window.showWarningMessage(
          'VersionCon: open a workspace folder before opening chat.',
        );
        return;
      }
      // Resolve member count from presence (other members + self if known).
      const memberCount = (presenceTreeProvider?.getEntries() ?? []).length;

      ChatPanel.createOrShow(context, {
        selfId: currentSelfMemberId,
        selfDisplayName: currentSelfDisplayName,
        branch: currentBranchName ?? 'main',
        memberCount,
        getRecords: () => clientChatRecords.slice(),
        getChatHiddenBefore: () => workspaceStateRef?.getChatHiddenBefore() ?? null,
        sendChatMessage: (body: string) => {
          if (!activeClient && !activeHost) return;
          const recordId = crypto.randomUUID();
          if (activeClient) {
            // Wire path — host server-stamps memberId / timestamp on receipt
            // and broadcasts back to all members (including the sender).
            activeClient.sendMessage({
              type: 'chat-message',
              timestamp: createTimestamp(),
              recordId,
              kind: 'user',
              memberId: currentSelfMemberId,
              memberDisplayName: currentSelfDisplayName,
              body,
            });
          } else if (activeHost) {
            // Host-local path — Plan 04-04 OWNS handleLocalChatMessage.
            // It performs chatLog.append + broadcast in one place, so the
            // host's own message reaches all clients via the same fan-out.
            void activeHost.handleLocalChatMessage({
              recordId,
              kind: 'user',
              body,
            });
            // Echo into the host's own panel — the host does NOT receive
            // its own broadcast back over the wire (it IS the broadcaster).
            // Local Date.now() is fine here; ordering inside the host's own
            // panel is the only thing that depends on this timestamp.
            dispatchChatReceivedLocally({
              id: recordId,
              kind: 'user',
              memberId: currentSelfMemberId,
              memberDisplayName: currentSelfDisplayName,
              body,
              timestamp: Date.now(),
            });
          }
        },
        openManageChat: () => {
          void vscode.commands.executeCommand('versioncon.manageChat');
        },
        getConnectionStatus: () => currentConnectionStatus,
        // CR-04 (Plan 04-14): wire unread-clear into the refs bundle so
        // the panel's own onDidChangeViewState Disposable (lifecycle-bound
        // to this.disposables in ChatPanel.ts) is the single owner of
        // this handler. Replaces the previous standalone setter call,
        // which leaked across extension reactivations because the
        // setter return value was never disposed.
        onPanelActivated: (active: boolean) => {
          chatPanelIsActive = active;
          if (active) {
            unreadChatCount = 0;
            statusBarManager?.setUnreadCount(0);
            activityLogProvider?.setUnread(0);
          }
        },
      });
    }),
  );

  // --- Phase 6 Plan 06-04: versioncon.openReview command ---
  // Two invocation paths:
  //   - No arg: QuickPick over reviews from ReviewState.getReviewsForBranch
  //     (filtered to status !== 'resolved' / 'abandoned'), with a "Start a
  //     new review on a recent push" option for the current user's pushes
  //     that don't yet have one.
  //   - With pushId arg: open the panel directly for that pushId. If no
  //     ReviewRequest yet exists for the pushId, prompt the user to open
  //     one (only allowed if they are the push author per 06-SPEC.md
  //     "Author opens it" locked decision).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'versioncon.openReview',
      (argPushId?: string) => {
        void openReviewCommandImpl(context, typeof argPushId === 'string' ? argPushId : null);
      },
    ),
  );

  // --- Phase 6 Plan 06-05: versioncon.review.replyToComment command ---
  // Invoked by VS Code's built-in "Reply" UI on a CommentThread when
  // thread.canReply === true. The CommentReply carries the thread's URI +
  // range; we map back to {filePath, line} relative to the active branch
  // dir and forward through the same wire-frame path as the panel composer
  // (host-trusted identity override applies — T-06-01 mitigation in Plan 06-02).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'versioncon.review.replyToComment',
      (reply: vscode.CommentReply) => {
        if (!reply || !reply.thread || typeof reply.text !== 'string') return;
        if (!activeVersionconDir || !reviewState) {
          void vscode.window.showWarningMessage(
            'VersionCon: review state not initialized.',
          );
          return;
        }
        const panel = ReviewPanel.currentPanel;
        if (!panel) {
          void vscode.window.showWarningMessage(
            'VersionCon: open the review panel to reply.',
          );
          return;
        }
        const review =
          reviewState.getActiveReviewForPush(panel.scopedPushId)
            ?? reviewState.getReviewByPushId(panel.scopedPushId);
        if (!review) {
          void vscode.window.showWarningMessage(
            'VersionCon: no active review for this push.',
          );
          return;
        }
        const branch = currentBranchName ?? review.branch;
        const branchDir = path.join(activeVersionconDir, 'branches', branch);
        const filePath = path
          .relative(branchDir, reply.thread.uri.fsPath)
          .replace(/\\/g, '/');
        const range = reply.thread.range;
        if (!range) {
          void vscode.window.showWarningMessage(
            'VersionCon: thread has no line range — cannot reply.',
          );
          return;
        }
        const line = range.start.line + 1;
        const callbacks = buildReviewPanelCallbacks();
        callbacks.onCommentRequested(review.id, filePath, line, reply.text);
      },
    ),
  );

  // Phase 4 (Plan 04-11): versioncon.manageChat — five-action QuickPick per
  // UI-SPEC §6.4 with three host-only destructive actions (delete-all, two
  // truncate modes), one per-user soft action (Clear my view), and one export.
  // Host gating per T-04-11-01 / T-04-11-06: items 2-4 still appear for
  // non-host members (with description "(host only — disabled)") so they
  // understand the option exists but isn't theirs; selection is rejected
  // server-side as well — Plan 04-04's onmessage switch has NO inbound
  // chat-cleared / chat-truncated branch, so a malicious client cannot
  // synthesize either wire type even by editing this command's source.
  context.subscriptions.push(
    vscode.commands.registerCommand('versioncon.manageChat', async () => {
      if (!activeClient && !activeHost) {
        void vscode.window.showWarningMessage(
          'Not connected. Host or join a session first.',
        );
        return;
      }
      // v1 has exactly one host per session; activeHost !== null is the
      // local-host check. T-04-11-01 + T-04-11-06: also enforced server-side
      // by Plan 04-04 (no inbound handler for chat-cleared/chat-truncated).
      const isHost = activeHost !== null;

      interface ManageChatItem extends vscode.QuickPickItem { id: string; }
      const items: ManageChatItem[] = [
        {
          id: 'clear-my-view',
          label: '$(eye-closed) Clear my view',
          description: 'Hide existing messages from your panel only.',
        },
        {
          id: 'delete-all',
          label: '$(trash) Delete entire chat',
          description: isHost
            ? 'Truncate chat-log.json. Affects everyone.'
            : '(host only — disabled)',
        },
        {
          id: 'truncate-keep-100',
          label: '$(history) Truncate: keep last 100 + activity',
          description: isHost
            ? 'Removes old user messages, keeps push/revert/branch events.'
            : '(host only — disabled)',
        },
        {
          id: 'truncate-activity-only',
          label: '$(filter) Truncate: keep only activity events',
          description: isHost
            ? 'Removes ALL user chat messages, keeps push/revert/branch events.'
            : '(host only — disabled)',
        },
        {
          id: 'export',
          label: '$(export) Export chat to file',
          description: 'Save your current view to .json or .md on your machine.',
        },
      ];

      const chosen = await vscode.window.showQuickPick(items, {
        title: 'VersionCon: Manage chat',
        placeHolder: 'Choose an action…',
        ignoreFocusOut: true,
      });
      if (!chosen) return;

      switch (chosen.id) {
        case 'clear-my-view': {
          // UI-SPEC §6.5 literal copy. positive-verb confirm button.
          const yes = await vscode.window.showWarningMessage(
            'Clear chat from your view?',
            {
              modal: true,
              detail: 'This hides existing messages from your panel only. Other members are not affected. Future messages will continue to appear.',
            },
            'Clear my view',
          );
          if (yes !== 'Clear my view') return;
          if (workspaceStateRef) {
            await workspaceStateRef.setChatHiddenBefore(Date.now());
          }
          // Refresh the panel with the now-filtered cache. setHistory takes a
          // pre-filtered array; ChatPanel's getRecords ref re-reads
          // chatHiddenBefore at panel-build time, but live setHistory needs
          // an explicit filter here.
          const cutoff = workspaceStateRef?.getChatHiddenBefore() ?? null;
          const visible = cutoff != null
            ? clientChatRecords.filter(r => r.timestamp >= cutoff)
            : clientChatRecords.slice();
          ChatPanel.currentPanel?.setHistory(visible);
          return;
        }

        case 'delete-all': {
          if (!isHost) {
            void vscode.window.showInformationMessage(
              'Only the host can run this action.',
            );
            return;
          }
          const yes = await vscode.window.showWarningMessage(
            'Delete entire chat for everyone?',
            {
              modal: true,
              detail: "This permanently removes all chat messages and activity events from chat-log.json. Other members' panels will go blank. This cannot be undone.",
            },
            'Delete all',
          );
          if (yes !== 'Delete all') return;
          if (activeChatLog) {
            await activeChatLog.clearAll();
          }
          clientChatRecords.length = 0;
          activeHost!.broadcastChatCleared(
            currentSelfMemberId,
            currentSelfDisplayName,
          );
          ChatPanel.currentPanel?.notifyChatCleared(currentSelfDisplayName);
          ChatPanel.currentPanel?.setHistory([]);
          return;
        }

        case 'truncate-keep-100': {
          if (!isHost) {
            void vscode.window.showInformationMessage(
              'Only the host can run this action.',
            );
            return;
          }
          const yes = await vscode.window.showWarningMessage(
            'Truncate chat to last 100 messages?',
            {
              modal: true,
              detail: 'Older user messages will be removed for everyone. Push, revert, and branch-create events will be kept.',
            },
            'Truncate',
          );
          if (yes !== 'Truncate') return;
          if (activeChatLog) {
            await activeChatLog.truncateKeepLast100PlusActivity();
            // Re-seed the host's local cache from the truncated chat-log so
            // the panel matches what's on disk + what remote clients will see.
            clientChatRecords.length = 0;
            for (const r of activeChatLog.getRecords()) {
              clientChatRecords.push(r);
            }
          }
          activeHost!.broadcastChatTruncated(
            'keep-100-and-activity',
            currentSelfMemberId,
            currentSelfDisplayName,
          );
          ChatPanel.currentPanel?.notifyChatTruncated(
            currentSelfDisplayName,
            'keep-100-and-activity',
          );
          ChatPanel.currentPanel?.setHistory(clientChatRecords.slice());
          return;
        }

        case 'truncate-activity-only': {
          if (!isHost) {
            void vscode.window.showInformationMessage(
              'Only the host can run this action.',
            );
            return;
          }
          const yes = await vscode.window.showWarningMessage(
            'Remove all user chat messages?',
            {
              modal: true,
              detail: 'Every user message will be removed for everyone. Push, revert, and branch-create events will be kept.',
            },
            'Remove messages',
          );
          if (yes !== 'Remove messages') return;
          if (activeChatLog) {
            await activeChatLog.truncateActivityOnly();
            clientChatRecords.length = 0;
            for (const r of activeChatLog.getRecords()) {
              clientChatRecords.push(r);
            }
          }
          activeHost!.broadcastChatTruncated(
            'activity-only',
            currentSelfMemberId,
            currentSelfDisplayName,
          );
          ChatPanel.currentPanel?.notifyChatTruncated(
            currentSelfDisplayName,
            'activity-only',
          );
          ChatPanel.currentPanel?.setHistory(clientChatRecords.slice());
          return;
        }

        case 'export': {
          const target = await vscode.window.showSaveDialog({
            title: 'Export chat',
            filters: { 'JSON': ['json'], 'Markdown': ['md'] },
            saveLabel: 'Export',
          });
          if (!target) return;
          const ext = path.extname(target.fsPath).toLowerCase();
          const format: 'json' | 'md' = ext === '.md' ? 'md' : 'json';
          const hiddenBefore = workspaceStateRef?.getChatHiddenBefore() ?? undefined;
          if (isHost && activeChatLog) {
            // Host: write straight from chat-log.json via ChatLog.exportToFile
            // which honors hiddenBefore (>= boundary semantics from Plan 04-02).
            await activeChatLog.exportToFile(target.fsPath, format, hiddenBefore);
          } else {
            // Member: chat-log.json lives on the host. Write the in-memory
            // client cache instead, applying the same hiddenBefore filter so
            // exported content matches what the user sees in their panel.
            const visible = hiddenBefore != null
              ? clientChatRecords.filter(r => r.timestamp >= hiddenBefore)
              : clientChatRecords.slice();
            const content = format === 'json'
              ? JSON.stringify(visible, null, 2)
              : visible.map(r => formatChatRecordAsMarkdown(r)).join('\n\n---\n\n');
            await vscode.workspace.fs.writeFile(
              target,
              Buffer.from(content, 'utf-8'),
            );
          }
          void vscode.window.showInformationMessage(
            `Exported chat to ${target.fsPath}`,
          );
          return;
        }
      }
    }),
  );

  // --- Helper: wire host events to UI ---
  function wireHostEvents(host: SessionHost, sessionName: string, hostIdentity: HostIdentity): void {
    activeHost = host;
    // Plan 04.1-03: store the wizard-allocated HostIdentity at module scope
    // for forward-compat (future loopback SessionClient wiring will read
    // hostAuthSecret from here). hostMemberId below INTENTIONALLY remains
    // 'local-user' — see the activeHostIdentity declaration block for the
    // IIFE admin-bypass invariant rationale.
    activeHostIdentity = hostIdentity;
    // Host is always the first member -- track the host's local member ID for
    // permission checks (canPushToBranch, canCreateBranch host-bypass).
    // The host's local commands run with currentMemberId = 'local-user', which
    // matches the default hostMemberId, so host actions always pass.
    hostMemberId = 'local-user';
    // Phase 3: wire permissions + push history into the host so it can validate
    // relays and populate sync-response.latestPushId. References may be null if
    // the workspace IIFE hasn't completed yet -- the IIFE re-wires after load().
    if (activePermissions) {
      host.setPermissions(activePermissions);
    }
    if (activePushHistory) {
      host.setPushHistory(activePushHistory);
    }
    // Phase 4 (Plan 04-11): wire the active branch's ChatLog into the host so
    // chat-message arrivals persist + chat-history replay populates joiners.
    // The IIFE may run before or after this — in both orders the late-arriving
    // half re-wires (IIFE checks activeHost; here we check activeChatLog).
    if (activeChatLog && currentBranchName) {
      host.setChatLog(activeChatLog, currentBranchName);
    }
    statusBarManager.setStatus('connected', sessionName);
    // Phase 4 (Plan 04-10): reflect host-session connected state into the
    // module-level mirror so ChatPanel.refs.getConnectionStatus() returns
    // 'connected' immediately after a host session starts.
    currentConnectionStatus = 'connected';
    ChatPanel.currentPanel?.setConnectionStatus('connected');
    // Phase 4: host runs as 'local-user' for permission checks; mirror that into
    // the self-identity fields used by the activity log + presence broadcasts.
    currentSelfMemberId = hostMemberId;
    // Phase 4 UAT fix (999.4): mirror the wizard-allocated displayName too,
    // otherwise the host's PresenceInfo carries the literal default 'You' and
    // every panel renders rows with name="You".
    currentSelfDisplayName = hostIdentity.displayName;
    presenceTreeProvider?.setSelfMemberId(currentSelfMemberId);
    void vscode.commands.executeCommand(
      'setContext', 'versioncon.connected', true,
    );
    // Phase 4 UAT fix (2026-05-10): build the host's own sidebar member list
    // INCLUDING the host's self row (Alice's MEMBERS panel should show Alice).
    // host.getMembers() returns only joined clients — Plan 04.1-02 stores
    // host identity separately as hostMemberId/hostDisplayName.
    const buildHostSidebarMembers = (): Array<{ id: string; displayName: string; role: 'host' | 'member'; isOnline: boolean; }> => {
      const list: Array<{ id: string; displayName: string; role: 'host' | 'member'; isOnline: boolean; }> = [
        {
          id: hostIdentity.memberId,
          displayName: hostIdentity.displayName,
          role: 'host',
          isOnline: true,
        },
      ];
      for (const m of host.getMembers()) {
        list.push({ id: m.id, displayName: m.displayName, role: m.role, isOnline: m.isOnline });
      }
      return list;
    };

    sidebarProvider.updateState({
      connectionStatus: 'connected',
      sessionName,
      role: 'host',
      members: buildHostSidebarMembers(),
      bandwidthStats: host.getBandwidthStats(),
    });

    host.on('member-joined', () => {
      sidebarProvider.updateState({
        members: buildHostSidebarMembers(),
        bandwidthStats: host.getBandwidthStats(),
      });
    });

    host.on('member-left', () => {
      sidebarProvider.updateState({
        members: buildHostSidebarMembers(),
        bandwidthStats: host.getBandwidthStats(),
      });
    });

    // Phase 4 UAT fix (999.3b): when a remote member sends presence-update,
    // SessionHost upserts the info into PresenceMap AND emits 'presence-update'
    // so the host's own PresenceTreeProvider can render the peer's row.
    // Mirrors the client-side wireClientEvents listener.
    host.on('presence-update', (info: PresenceInfo) => {
      presenceTreeProvider?.upsert(info);
      updatePresenceContext();
    });

    // Phase 5 Plan 05-05 (SC-5): the host's runAstAnalysisAndAmend emits this
    // event when the analyzer returns non-empty results so the HOST's own UI
    // (ChatPanel + ActivityLogProvider) sees the amend — the host does not
    // receive its own broadcast over the wire. Mirrors the chat-received
    // local-echo pattern at extension.ts:255 (dispatchChatReceivedLocally).
    host.on('chat-message-amend', (data: {
      recordId: string;
      affectedSymbols: import('./ast/types.js').AffectedSymbol[];
      unsupportedLanguages: string[];
    }) => {
      applyAmendLocally(data.recordId, data.affectedSymbols, data.unsupportedLanguages);
    });

    // Phase 4 UAT fix (999.3): when a member leaves, drop their presence row
    // from the host's panel (the broadcast-out to other clients is already
    // handled by SessionHost's member-left broadcast path, but the host's own
    // tree needs explicit cleanup).
    host.on('member-left', (data: { memberId: string }) => {
      presenceTreeProvider?.removeMember(data.memberId);
      updatePresenceContext();
    });

    // ----- Phase 6 Plan 06-04: review event wiring (host path) -----
    // The host's own process also needs ReviewState updates so its
    // ReviewPanel reflects events that originated on peer joiners (the host
    // does not receive its own broadcasts over the wire). Mirrors the
    // chat-message-amend echo pattern.

    host.on('review-state-sync', (data) => {
      if (!reviewState) return;
      reviewState.applyStateSync(data.branch, data.reviews);
      refreshReviewPanelIfOpen();
      rebuildInlineReviewComments();
    });

    host.on('review-opened', (data) => {
      if (!reviewState) return;
      reviewState.applyOpened(data.review);
      if (ReviewPanel.currentPanel?.scopedPushId === data.review.pushId) {
        refreshReviewPanelIfOpen();
        rebuildInlineReviewComments();
      }
    });

    host.on('review-comment', (data) => {
      if (!reviewState) return;
      reviewState.applyComment(data.reviewId, data.comment);
      refreshReviewPanelIfOpen();
      rebuildInlineReviewComments();
    });

    host.on('review-vote', (data) => {
      if (!reviewState) return;
      reviewState.applyVote(data.reviewId, data.vote);
      refreshReviewPanelIfOpen();
    });

    host.on('review-resolved', (data) => {
      if (!reviewState) return;
      reviewState.applyResolved(
        data.reviewId,
        data.resolvedBy,
        data.resolvedReason,
        Date.now(),
      );
      refreshReviewPanelIfOpen();
    });

    host.on('session-ended', () => {
      activeHost = null;
      // Plan 04.1-03: drop the pre-allocated HostIdentity reference so the
      // hostAuthSecret is not retained beyond the live session.
      activeHostIdentity = null;
      // Phase 5 Plan 05-05 (SC-5): tear down the host-side AST analyzer so
      // the forked worker process exits with the session. dispose() is
      // idempotent — safe even if never wired (no-op).
      if (activeAstAnalyzer) {
        try {
          activeAstAnalyzer.dispose();
        } catch (err) {
          console.error('[VersionCon] AstAnalyzer.dispose failed', err);
        }
        activeAstAnalyzer = null;
      }
      statusBarManager.setStatus('disconnected');
      // Phase 4 (Plan 04-10): mirror disconnected status + clear chat cache;
      // the chat panel's banner switches to "Disconnected. Messages won't
      // send until you reconnect." per UI-SPEC §7.3.
      currentConnectionStatus = 'disconnected';
      clientChatRecords.length = 0;
      ChatPanel.currentPanel?.setConnectionStatus('disconnected');
      // Phase 4: drop everyone from the presence panel + reset connected context.
      presenceTreeProvider?.clear();
      presenceTreeProvider?.setSelfMemberId(null);
      presenceTreeProvider?.setCurrentBranch(null);
      updatePresenceContext();
      void vscode.commands.executeCommand('setContext', 'versioncon.connected', false);
      sidebarProvider.updateState({
        connectionStatus: 'disconnected',
        sessionName: null,
        role: null,
        members: [],
        bandwidthStats: null,
      });
      // Close the wizard panel if it's still open (prevents stale "Session Active" state)
      if (WizardPanel.currentPanel) {
        WizardPanel.currentPanel.onSessionEnded();
      }
    });
  }

  // --- Helper: wire client events to UI ---
  function wireClientEvents(client: SessionClient): void {
    activeClient = client;
    const info = client.getSessionInfo();
    statusBarManager.setStatus('connected', info?.name);
    // Phase 4 (Plan 04-10): mirror connected status for ChatPanel refs.
    currentConnectionStatus = 'connected';
    ChatPanel.currentPanel?.setConnectionStatus('connected');
    // Phase 4: capture self identity from the authenticated SessionClient so
    // activity-log isMine flags + presence-update broadcasts use the real id
    // (not the 'local-user' placeholder used by host-side commands).
    const selfId = client.getMemberId();
    if (selfId) {
      currentSelfMemberId = selfId;
      const selfMember = client.getMembers().find(m => m.id === selfId);
      if (selfMember) {
        currentSelfDisplayName = selfMember.displayName;
      }
    }
    presenceTreeProvider?.setSelfMemberId(currentSelfMemberId);
    void vscode.commands.executeCommand(
      'setContext', 'versioncon.connected', true,
    );
    sidebarProvider.updateState({
      connectionStatus: 'connected',
      sessionName: info?.name ?? null,
      role: 'member',
      members: client.getMembers().map((m) => ({
        id: m.id, displayName: m.displayName, role: m.role, isOnline: m.isOnline,
      })),
      bandwidthStats: null,
    });

    // Phase 4 UAT fix (999.5): joiner onboarding. The joiner's workspace may
    // be brand new (no .versioncon/ at all) — BranchManager.initialize() will
    // have just created an empty .versioncon/branches/<branch>/, and the
    // BRANCH FILES panel will show the "No branch files found" viewsWelcome
    // empty state with no hint about what to do next. Surface a one-time
    // notification per session that explains where files live and offers a
    // reveal-in-explorer action so the user can orient themselves.
    void (async () => {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!wsRoot) return;
      const branch = currentBranchName ?? 'main';
      const versionconPath = path.join(wsRoot, '.versioncon');
      const branchPath = path.join(versionconPath, 'branches', branch);
      const sessionLabel = info?.name ? `'${info.name}'` : 'the session';
      const sessionNameSafe = info?.name ?? 'this session';
      const action = await vscode.window.showInformationMessage(
        `Joined ${sessionLabel}. Branch files for '${branch}' live at ${branchPath}. ` +
        `Push files from your workspace to share them with the team.`,
        'Open .versioncon Folder',
        'Dismiss',
      );
      if (action === 'Open .versioncon Folder') {
        try {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(versionconPath));
        } catch {
          // revealFileInOS may not be available in headless test runs — fall back to a no-op.
        }
      }
      // Mark sessionNameSafe used so unused-var lint stays quiet across compilers.
      void sessionNameSafe;
    })();

    client.on('member-joined', () => {
      sidebarProvider.updateState({
        members: client.getMembers().map((m) => ({
          id: m.id, displayName: m.displayName, role: m.role, isOnline: m.isOnline,
        })),
      });
    });

    client.on('member-left', () => {
      sidebarProvider.updateState({
        members: client.getMembers().map((m) => ({
          id: m.id, displayName: m.displayName, role: m.role, isOnline: m.isOnline,
        })),
      });
    });

    client.on('connection-changed', (data: { status: ConnectionStatus; error?: string }) => {
      statusBarManager.setStatus(data.status, info?.name);
      // Phase 4 (Plan 04-10): mirror status into module scope so the chat
      // panel's reconnecting / disconnected banners follow the live state.
      currentConnectionStatus = data.status;
      ChatPanel.currentPanel?.setConnectionStatus(data.status);
      sidebarProvider.updateState({
        connectionStatus: data.status,
        error: data.status === 'disconnected' ? (data.error ?? 'Connection lost') : null,
      });
      // Phase 4: drive the viewsWelcome `when` clauses for activity + presence.
      void vscode.commands.executeCommand(
        'setContext', 'versioncon.connected', data.status === 'connected',
      );
      // D-11: if 'reconnecting', no toast. D-12: no workspace lockout.
      if (data.status === 'disconnected' && data.error) {
        vscode.window.showWarningMessage(`VersionCon: ${data.error}`);
      }
      // PUSH-09: reset sync tracker on disconnect so the next session starts
      // from a clean state. On reconnect, sync-response reseeds latestPushId.
      if (data.status === 'disconnected') {
        syncTracker.reset();
        // Phase 4: clear the presence panel — the host's snapshot is gone.
        presenceTreeProvider?.clear();
        presenceTreeProvider?.setSelfMemberId(null);
        presenceTreeProvider?.setCurrentBranch(null);
        updatePresenceContext();
      }
    });

    // Phase 3 + 4: Handle push/branch notifications from other members
    client.on('push-received', (data) => {
      // PUSH-09: track remote push -- workspace is now potentially out of sync
      syncTracker.onRemotePush(data.pushId);
      // PUSH-10/11: record per-file out-of-sync paths so versioncon.sync can
      // pull each one and prompt on conflict.
      syncTracker.recordRemoteFiles(data.files.map(f => f.relativePath));

      // Phase 4 (CONF-07/CONF-08, COLLAB-04): compute open-tab overlap and dispatch
      // either the toast or the green flash. Activity tree gets a row in both cases.
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const pushedRel = data.files.map(f => f.relativePath);
      const { overlapping } = computeFileOverlap(
        pushedRel,
        getOpenTabPaths(),
        wsRoot,
        process.platform,
      );

      // Activity log entry (UI-SPEC §6.3 labels rendered by ActivityLogProvider).
      activityLogProvider?.addPushEntry({
        timestamp: Date.now(),
        memberId: data.memberId,
        memberDisplayName: data.memberDisplayName,
        isMine: data.memberId === currentSelfMemberId,
        files: pushedRel,
        pushMessage: data.message,
        affectsLocal: overlapping.length > 0,
        // Phase 5 Plan 05-05 (SC-5): stamp the pushId so a subsequent
        // chat-received system event can link the chat record id via
        // ActivityLogProvider.linkChatRecordToPush. The chatRecordId is
        // then the lookup key for applyAmend when the AST analyzer's
        // chat-message-amend arrives.
        pushId: data.pushId,
      });
      updateActivityContext();

      if (overlapping.length > 0) {
        // CONF-07: file-level overlap → soft non-modal toast (UI-SPEC §6.1 strings).
        // PUSH-09 sync-warning still fires (Phase 3 contract preserved).
        statusBarManager.setSyncWarning(true);
        void vscode.window.showInformationMessage(
          formatPushToast(data.memberDisplayName, overlapping, data.message),
        );
      } else if (data.files.length > 0) {
        // CONF-08: no overlap → 5s green status flash, no toast (UI-SPEC §6.2).
        statusBarManager.flashNoImpact(data.files.length, 5000);
      }
    });

    client.on('push-reverted', (data) => {
      // PUSH-09: a revert changes branch state -- treat as a remote push so
      // the user is prompted to acknowledge.
      syncTracker.onRemotePush(data.pushId);
      // PUSH-10/11: revert touches the same set of files; record them so
      // versioncon.sync can reconcile.
      syncTracker.recordRemoteFiles(data.files);
      statusBarManager.setSyncWarning(true);
      // Phase 4: activity log row for the revert.
      activityLogProvider?.addRevertEntry({
        timestamp: Date.now(),
        memberId: data.memberId,
        memberDisplayName: data.memberDisplayName,
        isMine: data.memberId === currentSelfMemberId,
        files: data.files,
        affectsLocal: false,
      });
      updateActivityContext();
      void vscode.window.showInformationMessage(
        `${data.memberDisplayName} reverted a push on branch "${data.branch}"`,
      );
    });

    // PUSH-09: seed sync tracker from sync-response on reconnect. The host
    // emits sync-response carrying the latest known pushId; if a push has
    // happened while disconnected, the client treats it as a remote push and
    // is therefore out of sync. SessionClient does not currently emit this
    // event today; the listener is harmless if never fired.
    client.on('sync-response', (data) => {
      if (data.latestPushId) {
        syncTracker.onRemotePush(data.latestPushId);
      }
      // NOTE: SyncResponse carries files: PushFileEntry[] (currently always
      // empty from the host; the typed client event omits it). When the host
      // starts populating files in a later phase, seed via recordRemoteFiles
      // here.
    });

    client.on('branch-created', (data) => {
      // BRANCH-03: refresh the all-branches view when a remote member creates a branch
      if (activeBranchListProvider) {
        activeBranchListProvider.refresh();
      }
      // Phase 4: activity log row for the branch creation.
      activityLogProvider?.addBranchCreateEntry({
        timestamp: Date.now(),
        memberId: data.branch.createdBy ?? '',
        memberDisplayName: data.branch.createdBy ?? '',
        isMine: data.branch.createdBy === currentSelfMemberId,
        branchName: data.branch.name,
      });
      updateActivityContext();
      void vscode.window.showInformationMessage(
        `New branch created: "${data.branch.name}" by ${data.branch.createdBy}`,
      );
    });

    client.on('branch-locked', (data) => {
      // BRANCH-03: refresh the all-branches view when a remote member locks/unlocks a branch
      if (activeBranchListProvider) {
        activeBranchListProvider.refresh();
      }
      void vscode.window.showInformationMessage(
        `Branch "${data.branchName}" was ${data.locked ? 'locked' : 'unlocked'}`,
      );
    });

    // ----- Phase 4: presence + chat client event wiring (Plan 04-09) -----

    client.on('presence-update', (info: PresenceInfo) => {
      presenceTreeProvider?.upsert(info);
      updatePresenceContext();
    });

    client.on('member-left', (data: { memberId: string }) => {
      presenceTreeProvider?.removeMember(data.memberId);
      updatePresenceContext();
    });

    client.on('chat-received', (record: ChatRecord) => {
      // System events (push/revert/branch-created) ALSO ride the chat stream — but
      // push-received / push-reverted / branch-created already feed the activity
      // log via their dedicated client events above. We only need to surface USER
      // chat messages here as unread badges; system events are already accounted for.
      clientChatRecords.push(record);
      if (record.kind === 'user' && !chatPanelIsActive) {
        unreadChatCount += 1;
        statusBarManager?.setUnreadCount(unreadChatCount);
        activityLogProvider?.setUnread(unreadChatCount);
      }
      // Plan 04-10: forward to chat panel iff the panel is open.
      ChatPanel.currentPanel?.postChatMessage(record);

      // Phase 5 Plan 05-05 (SC-5): system events for pushes carry a meta.pushId
      // (set by SessionHost.broadcastPush via appendAndBroadcastSystemEvent).
      // Stamp the chat record's id onto the matching activity entry so a
      // subsequent chat-message-amend can locate the entry by id.
      if (
        record.kind === 'system' &&
        record.subKind === 'push' &&
        record.meta?.pushId
      ) {
        activityLogProvider?.linkChatRecordToPush(record.meta.pushId, record.id);
      }
    });

    // Phase 5 Plan 05-05 (SC-5): host fires this after AST analysis completes
    // so we patch the cached chat record's meta + propagate to ChatPanel +
    // ActivityLogProvider. Mirrors the host echo path inside wireHostEvents.
    client.on('chat-message-amend', (data: {
      recordId: string;
      affectedSymbols: import('./ast/types.js').AffectedSymbol[];
      unsupportedLanguages: string[];
    }) => {
      applyAmendLocally(data.recordId, data.affectedSymbols, data.unsupportedLanguages);
    });

    client.on('chat-cleared', (data: { hostMemberId: string; hostDisplayName: string }) => {
      // Host wiped the chat for everyone (UI-SPEC §7.3). Clear local cache,
      // unread state, and the sticky tree row. Then forward to the panel +
      // surface the info toast.
      clientChatRecords.length = 0;
      unreadChatCount = 0;
      statusBarManager?.setUnreadCount(0);
      activityLogProvider?.setUnread(0);
      ChatPanel.currentPanel?.notifyChatCleared(data.hostDisplayName);
      void vscode.window.showInformationMessage(
        `${data.hostDisplayName} cleared the chat for everyone.`,
      );
    });

    client.on('chat-truncated', (data: {
      mode: 'keep-100-and-activity' | 'activity-only';
      hostMemberId: string;
      hostDisplayName: string;
    }) => {
      // Drop the local cache; the next chat-history event (or live messages
      // from the host) will reseed it. Webview shows empty in the interim.
      clientChatRecords.length = 0;
      ChatPanel.currentPanel?.notifyChatTruncated(data.hostDisplayName, data.mode);
      const modeText = data.mode === 'keep-100-and-activity'
        ? 'keeping last 100 + activity'
        : 'keeping activity only';
      void vscode.window.showInformationMessage(
        `${data.hostDisplayName} truncated the chat (${modeText}).`,
      );
    });

    client.on('chat-history', (data: { branch: string; records: ChatRecord[] }) => {
      // Replace the local cache with the host's snapshot (last 100 records
      // by Plan 04-04 contract). RESEARCH Open Q #2 ordering is
      // auth-response → state-sync → chat-history, so we may receive this
      // before the panel is open; the cache is still primed for next open.
      clientChatRecords.length = 0;
      for (const r of data.records) clientChatRecords.push(r);
      ChatPanel.currentPanel?.setHistory(clientChatRecords.slice());
    });

    // ----- Phase 6 Plan 06-04: review event wiring (client path) -----
    // 5 listeners forwarding into ReviewState.apply* + ReviewPanel.refresh.
    // T-06-05 wire-source trust: these events fire only from SessionClient.
    // handleMessage which is fed by the single host ws — no peer-to-peer path.

    client.on('review-state-sync', (data) => {
      if (!reviewState) return;
      reviewState.applyStateSync(data.branch, data.reviews);
      refreshReviewPanelIfOpen();
      rebuildInlineReviewComments();
    });

    client.on('review-opened', (data) => {
      if (!reviewState) return;
      reviewState.applyOpened(data.review);
      if (ReviewPanel.currentPanel?.scopedPushId === data.review.pushId) {
        refreshReviewPanelIfOpen();
        rebuildInlineReviewComments();
      }
    });

    client.on('review-comment', (data) => {
      if (!reviewState) return;
      reviewState.applyComment(data.reviewId, data.comment);
      refreshReviewPanelIfOpen();
      rebuildInlineReviewComments();
    });

    client.on('review-vote', (data) => {
      if (!reviewState) return;
      reviewState.applyVote(data.reviewId, data.vote);
      refreshReviewPanelIfOpen();
    });

    client.on('review-resolved', (data) => {
      if (!reviewState) return;
      reviewState.applyResolved(
        data.reviewId,
        data.resolvedBy,
        data.resolvedReason,
        Date.now(),
      );
      refreshReviewPanelIfOpen();
    });
  }

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('versioncon.hostSession', () => {
      void WizardPanel.createOrShow(
        context,
        (host: SessionHost, sessionName: string, hostIdentity: HostIdentity) => {
          wireHostEvents(host, sessionName, hostIdentity);
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('versioncon.joinSession', () => {
      void JoinPanel.createOrShow(context, sessionHistory, (client: SessionClient) => {
        wireClientEvents(client);
      });
    }),
  );

  // Phase 7 (Plan 07-06): UriHandler for vscode://versioncon.versioncon/join?...
  // deep-links. Registered programmatically — package.json's
  // activationEvents: ["onUri"] guarantees cold-start activation when a deep
  // link arrives while the extension is not yet loaded.
  context.subscriptions.push(
    vscode.window.registerUriHandler(
      new VersionConUriHandler(context, sessionHistory, (client: SessionClient) => {
        wireClientEvents(client);
      }),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('versioncon.showSidebar', () => {
      void vscode.commands.executeCommand('versioncon.sidebar.focus');
    }),
  );

  // --- Sidebar disconnect handler ---
  sidebarProvider.onDisconnectRequested(async () => {
    // If host, show confirmation dialog before disconnecting (D-15)
    if (activeHost) {
      const members = activeHost.getMembers();
      const otherMemberCount = members.filter(m => m.role !== 'host').length;

      if (otherMemberCount > 0) {
        const choice = await vscode.window.showWarningMessage(
          `Ending this session will disconnect ${otherMemberCount} member${otherMemberCount > 1 ? 's' : ''}. Continue?`,
          { modal: true },
          'End Session',
        );
        if (choice !== 'End Session') {
          return; // User canceled — do nothing
        }
      }

      activeHost.stop();
      activeHost = null;
    }

    if (activeClient) {
      activeClient.disconnect();
      activeClient = null;
    }

    statusBarManager.setStatus('disconnected');
    // Phase 4 (Plan 04-10): mirror disconnected status into the chat panel
    // and drop the local cache. The next session reseeds via chat-history.
    currentConnectionStatus = 'disconnected';
    clientChatRecords.length = 0;
    ChatPanel.currentPanel?.setConnectionStatus('disconnected');
    sidebarProvider.updateState({
      connectionStatus: 'disconnected',
      sessionName: null,
      role: null,
      members: [],
      bandwidthStats: null,
    });
  });

  // --- Sidebar kick handler ---
  sidebarProvider.onKickRequested((memberId: string) => {
    if (activeHost) {
      activeHost.kickMember(memberId, 'Kicked by host');
    }
  });

  // --- TreeView-based workspace (Phase 2+3) ---
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  let workspaceProvider: WorkspaceTreeProvider | null = null;

  if (workspaceFolder) {
    const versionconDir = path.join(workspaceFolder.uri.fsPath, '.versioncon');
    const legacyBranchDir = path.join(versionconDir, 'branch');

    // Initialize branch manager
    const branchManager = new BranchManager(versionconDir);
    const workspaceState = new WorkspaceState();
    // Phase 4 (Plan 04-10): bind the ExtensionContext so chatHiddenBefore is
    // restored from per-user workspaceState; expose via module-level ref so
    // versioncon.openChat (registered at activate scope) can read the cutoff.
    workspaceState.bindContext(context);
    workspaceStateRef = workspaceState;

    // Placeholder memberId — replaced when session is active
    let currentMemberId = 'local-user';
    let currentDisplayName = 'You';

    // Initialize services asynchronously
    void (async () => {
      await branchManager.initialize();

      const activeBranchDir = await branchManager.getActiveBranchDir();
      const activeBranchName = await branchManager.getActiveBranch();

      const fsLayer = new FileSystemLayer(workspaceFolder.uri.fsPath, activeBranchDir);

      const pushHistory = new PushHistory(versionconDir);
      await pushHistory.load();

      const pushService = new PushService(
        pushHistory,
        workspaceFolder.uri.fsPath,
        () => fsLayer.getBranchDir(),
        () => branchProvider.getActiveBranchName(),
      );

      const permissions = new BranchPermissions(versionconDir, currentMemberId);
      await permissions.load();

      // Phase 3: cache permissions + pushHistory at module scope so a host
      // session created later (via wireHostEvents) can pick them up. Also wire
      // the currently-active host (if any) immediately.
      activePermissions = permissions;
      activePushHistory = pushHistory;
      // Phase 6 Plan 06-04: also expose the full handle + versionconDir so the
      // openReview command (registered at activate scope) can look up
      // PushRecord by id and construct snapshot URIs.
      activePushHistoryFull = pushHistory;
      activeVersionconDir = versionconDir;

      const branchProvider = new BranchTreeProvider(fsLayer);
      branchProvider.setBranchDir(activeBranchDir);
      branchProvider.setActiveBranchName(activeBranchName);

      // Phase 4: mirror the active branch into module scope so presence-update
      // broadcasts and the divergence indicator stay in sync.
      currentBranchName = activeBranchName;
      presenceTreeProvider?.setCurrentBranch(activeBranchName);

      // Phase 4 (Plan 04-11): construct the active branch's ChatLog and wire
      // it into the host (if one is active) so arriving chat-message frames
      // persist and chat-history replay populates joiners. versioncon.manageChat
      // also reads activeChatLog directly for the host destructive actions
      // (clearAll / truncate*). load() tolerates a missing file (treated as
      // empty), so first-launch is safe.
      activeChatLog = new ChatLog(activeBranchDir);
      await activeChatLog.load();
      if (activeHost) {
        activeHost.setChatLog(activeChatLog, activeBranchName);
      }

      // Phase 6 Plan 06-04: construct + load the active branch's ReviewStore
      // and wire it into the host. Mirrors the activeChatLog wiring above.
      // load() walks .versioncon/branches/{branch}/reviews/*.json; missing dir
      // is treated as empty so first-launch is safe. The store is wired into
      // the host so review-* relay handlers can persist mutations.
      activeReviewStore = new ReviewStore(versionconDir);
      await activeReviewStore.load(activeBranchName);
      if (activeHost) {
        activeHost.setReviewStore(activeReviewStore, activeBranchName);
      }
      // Seed the in-memory ReviewState cache from disk so the host's own
      // ReviewPanel can render reviews persisted from prior sessions before
      // any wire frames arrive.
      if (reviewState) {
        reviewState.applyStateSync(
          activeBranchName,
          activeReviewStore.getAll().filter(r => r.branch === activeBranchName),
        );
      }

      // Phase 5 Plan 05-05 (SC-5): construct the host-side AST analyzer once
      // the workspace + branch are stable. The analyzer is host-only — clients
      // never instantiate. setBranchDirGetter resolves at call time so a
      // branch switch (line ~1811) doesn't require re-wiring the analyzer.
      // The analyzer itself is constructed once per session; dispose happens
      // in host.session-ended.
      if (activeHost && !activeAstAnalyzer) {
        activeAstAnalyzer = new AstAnalyzer(
          workspaceFolder.uri.fsPath,
          fsLayer.getBranchDir(),
        );
        activeHost.setAstAnalyzer(activeAstAnalyzer);
        activeHost.setBranchDirGetter(() => fsLayer.getBranchDir());
      }

      // --- Phase 8 (Plan 08-09): MCP subsystem startup ---
      // Fires once per workspace IIFE, gated by mcpStartupAttempted so a
      // future refactor that re-enters the IIFE (e.g. branch switch loop)
      // cannot double-start the server. The presence reader is a LAZY shim
      // that defers to the module-level `activeHost` at call time — this
      // means MCP starts BEFORE a session begins (single-user case), and
      // when a session later starts, presence data flows automatically
      // through the live `activeHost` reference. When no host is active,
      // the presence reader returns empty collections (read-only viewport
      // — never throws).
      //
      // Activation NEVER awaits this call (mirrors extension.ts:867-869's
      // ensureVersionconExcluded fire-and-forget pattern). The .catch site
      // routes errors to the MCP OutputChannel via getMcpOutputChannel —
      // never console.* (extension.ts:868 console.error is for Phase 4.3's
      // legacy ensureVersionconExcluded; MCP wiring uses log.appendLine).
      //
      // The lifecycle:
      //   (a) reads versioncon.mcp.enabled — defaults true (package.json)
      //   (b) awaits ensureConsent (08-05) — first-run prompt; persistent
      //   (c) starts the server on 127.0.0.1:<auto-port>/mcp (08-04)
      //   (d) writes BOTH .vscode/mcp.json AND .mcp.json (RESEARCH §B.4)
      //   (e) returns the McpServerHandle for deactivate-time shutdown
      //
      // Deactivate cleanup happens in deactivate() below — calls
      // stopMcpLifecycle on the captured handle + removes the mcp.json
      // entries (Pitfall 3 self-healing remains intact for next activation).
      if (!mcpStartupAttempted) {
        mcpStartupAttempted = true;
        const folder = workspaceFolder.uri.fsPath;
        mcpWorkspaceFolderPath = folder;
        const mcpLog = (line: string): void =>
          getMcpOutputChannel(context).appendLine(line);

        // Lazy PresenceReader shim: defers to the module-level `activeHost`
        // at call time so MCP can start before a session is active. Returns
        // empty collections when no host is present — matches the read-only
        // viewport contract (Phase 8 surfaces only what the local user sees;
        // no host == no presence to surface).
        const presenceReader = {
          getPresenceSnapshot(): readonly PresenceInfo[] {
            if (!activeHost) return [];
            return new PresenceReaderImpl(activeHost).getPresenceSnapshot();
          },
          getMemberTracking(): ReadonlyMap<string, readonly string[]> {
            if (!activeHost) return new Map();
            return new PresenceReaderImpl(activeHost).getMemberTracking();
          },
        };

        void startMcpLifecycle({
          context,
          log: mcpLog,
          deps: {
            branchReader: new BranchReaderImpl(branchManager),
            syncReader: new SyncReaderImpl(syncTracker),
            activityReader: new ActivityReaderImpl(pushHistory),
            chatReader: new ChatReaderImpl(activeChatLog),
            depReader: new DependencyReaderImpl({ workspaceRoot: folder }),
            presenceReader,
            log: mcpLog,
          },
          ensureConsent,
          upsertMcpConfig: async (port: number): Promise<void> => {
            const url = `http://127.0.0.1:${port}/mcp`;
            await upsertMcpConfig(folder, '.vscode/mcp.json', 'versioncon', url);
            await upsertMcpConfig(folder, '.mcp.json', 'versioncon', url);
          },
          removeMcpConfig: async (): Promise<void> => {
            await removeMcpConfig(folder, '.vscode/mcp.json', 'versioncon');
            await removeMcpConfig(folder, '.mcp.json', 'versioncon');
          },
        })
          .then((handle) => {
            runningMcpHandle = handle;
          })
          .catch((err) => {
            mcpLog(
              `[mcp] startup failed: ${String((err as Error)?.message ?? err)}`,
            );
          });
      }

      // BRANCH-03: all-branches tree (separate from active-branch file tree)
      const branchListProvider = new BranchListProvider(branchManager);
      branchListProvider.setActiveBranchName(activeBranchName);
      activeBranchListProvider = branchListProvider;

      workspaceProvider = new WorkspaceTreeProvider(fsLayer);

      // Register tree data providers
      context.subscriptions.push(
        vscode.window.registerTreeDataProvider('versioncon.branchTree', branchProvider),
        vscode.window.registerTreeDataProvider('versioncon.workspaceTree', workspaceProvider),
        vscode.window.registerTreeDataProvider('versioncon.branchList', branchListProvider),
      );

      // Phase 3 (PUSH-03): emit tracked-paths-update on workspace tracking
      // changes. Host path: write directly to memberTrackingMap. Client path:
      // send tracked-paths-update over WebSocket; the host mirrors it into
      // its map (after validating memberId from the auth'd connection).
      context.subscriptions.push(
        workspaceProvider.onTrackedPathsChanged((paths) => {
          if (activeHost) {
            activeHost.setHostTrackedPaths(currentMemberId, paths);
          }
          if (activeClient) {
            activeClient.sendMessage({
              type: 'tracked-paths-update',
              memberId: currentMemberId,
              paths,
              timestamp: createTimestamp(),
            });
          }
        }),
      );

      // Seed the initial tracked-paths set so the host knows the member's
      // starting state without waiting for a tracking change.
      const initialPaths = workspaceProvider.getTrackedPaths();
      if (activeHost) {
        activeHost.setHostTrackedPaths(currentMemberId, initialPaths);
      }
      if (activeClient) {
        activeClient.sendMessage({
          type: 'tracked-paths-update',
          memberId: currentMemberId,
          paths: initialPaths,
          timestamp: createTimestamp(),
        });
      }

      // --- Phase 4: presence broadcast on activeTextEditor change ---
      // CONTEXT.md "Presence broadcast cadence" locked: broadcast on
      // onDidChangeActiveTextEditor, no periodic heartbeat in v1. The event
      // already fires only on editor focus changes (NOT every keystroke), so
      // a small debounce is defensive — guards against rapid tab cycling.
      const sendPresenceUpdate = (editor: vscode.TextEditor | undefined): void => {
        if (!activeClient && !activeHost) return;
        const wsRoot = workspaceFolder.uri.fsPath;
        let activeFilePath: string | null = null;
        if (editor && wsRoot) {
          // Only count files inside the workspace; mirrors fileOverlap.ts's filter.
          const rel = path.relative(wsRoot, editor.document.uri.fsPath);
          if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
            // Normalize to posix (per chat.ts PresenceInfo.activeFilePath spec).
            activeFilePath = rel.split(path.sep).join('/');
          }
        }
        const branch = currentBranchName ?? 'main';
        if (activeClient) {
          activeClient.sendMessage({
            type: 'presence-update',
            timestamp: createTimestamp(),
            memberId: currentSelfMemberId,
            displayName: currentSelfDisplayName,
            branch,
            activeFilePath,
          });
          // Phase 4 UAT fix (999.3a): the host broadcasts presence-update with
          // sender-excluded (Plan 04-04 policy), so the client never receives
          // its own presence back. Without a local upsert here, the joiner's
          // own row would never appear in their own PRESENCE panel. Mirrors
          // the host-side explicit upsert at the activeHost branch below.
          const selfInfo: PresenceInfo = {
            memberId: currentSelfMemberId,
            displayName: currentSelfDisplayName,
            branch,
            activeFilePath,
            lastUpdated: createTimestamp(),
          };
          presenceTreeProvider?.upsert(selfInfo);
          updatePresenceContext();
        } else if (activeHost) {
          const info: PresenceInfo = {
            memberId: currentSelfMemberId,
            displayName: currentSelfDisplayName,
            branch,
            activeFilePath,
            lastUpdated: createTimestamp(),
          };
          activeHost.upsertHostPresence(info);
          // Mirror into the local presence tree so the host sees their own row.
          presenceTreeProvider?.upsert(info);
          updatePresenceContext();
        }
      };

      let presenceDebounceTimer: ReturnType<typeof setTimeout> | null = null;
      context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
          if (presenceDebounceTimer) clearTimeout(presenceDebounceTimer);
          // 100ms debounce — VS Code can fire the event multiple times during
          // rapid tab cycling (open + focus). One outbound message per real
          // intent is enough for the presence panel.
          presenceDebounceTimer = setTimeout(() => {
            sendPresenceUpdate(editor);
          }, 100);
        }),
      );

      // --- Commands ---

      // Preview a branch file (read-only)
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.previewBranchFile', (entry: { relativePath: string }) => {
          const branchDir = fsLayer.getBranchDir();
          const fileUri = vscode.Uri.file(path.join(branchDir, entry.relativePath));
          void vscode.commands.executeCommand('vscode.open', fileUri, { preview: true });
        }),
      );

      // Add a single file to workspace
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.addToWorkspace', async (entry: { relativePath: string }) => {
          try {
            await fsLayer.copyFileToWorkspace(entry.relativePath);
            workspaceProvider!.trackFile(entry.relativePath);
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to add file';
            void vscode.window.showErrorMessage(`VersionCon: ${msg}`);
          }
        }),
      );

      // Add all files in a folder to workspace
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.addFolderToWorkspace', async (entry: { relativePath: string }) => {
          try {
            const branchDir = fsLayer.getBranchDir();
            const filePaths = await fsLayer.collectFilePaths(branchDir, entry.relativePath);
            for (const filePath of filePaths) {
              await fsLayer.copyFileToWorkspace(filePath);
            }
            workspaceProvider!.trackFiles(filePaths);
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to add folder';
            void vscode.window.showErrorMessage(`VersionCon: ${msg}`);
          }
        }),
      );

      // Stage a file for push (replaces returnToBranch)
      // PUSH-09: hard block — out-of-sync workspaces cannot stage. The only
      // path forward is Sync; dismiss/Esc cancels the action.
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.stageForPush', async (entry: { relativePath: string }) => {
          if (!syncTracker.isInSync()) {
            const choice = await vscode.window.showInformationMessage(
              'Your workspace is out of sync with the latest branch state.',
              { modal: true, detail: 'You must Sync before staging. Click Sync to pull the latest branch versions, or close this dialog to cancel.' },
              'Sync',
            );
            if (choice !== 'Sync') return;
            await vscode.commands.executeCommand('versioncon.sync');
            if (!syncTracker.isInSync()) return; // user kept some local edits; do not proceed
          }
          workspaceState.stageFile(entry.relativePath);
          workspaceProvider!.stageFile(entry.relativePath);
        }),
      );

      // Unstage a file
      // PUSH-09: hard block — out-of-sync workspaces cannot unstage either.
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.unstageFile', async (entry: { relativePath: string }) => {
          if (!syncTracker.isInSync()) {
            const choice = await vscode.window.showInformationMessage(
              'Your workspace is out of sync with the latest branch state.',
              { modal: true, detail: 'You must Sync before unstaging. Click Sync to pull the latest branch versions, or close this dialog to cancel.' },
              'Sync',
            );
            if (choice !== 'Sync') return;
            await vscode.commands.executeCommand('versioncon.sync');
            if (!syncTracker.isInSync()) return;
          }
          workspaceState.unstageFile(entry.relativePath);
          workspaceProvider!.unstageFile(entry.relativePath);
        }),
      );

      // Preview diff for a staged file
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.previewDiff', async (entry: { relativePath: string }) => {
          const branchDir = fsLayer.getBranchDir();
          const branchUri = vscode.Uri.file(path.join(branchDir, entry.relativePath));
          const workspaceUri = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, entry.relativePath));
          await vscode.commands.executeCommand('vscode.diff', branchUri, workspaceUri, `${entry.relativePath} (Branch ↔ Workspace)`);
        }),
      );

      // Push staged files
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.push', async () => {
          const staged = workspaceState.getStagedFiles();
          let stagedPaths: string[];
          let autoStaged = false;
          if (staged.length === 0) {
            // Phase 4.3 SC-3: workspace-diff fallback when nothing is drag-staged.
            // Diffs workspace vs. active branch dir; uses allChanged as the
            // staged-paths list fed into the existing push pipeline.
            const differ = new WorkspaceDiffer();
            const diff = await differ.diff(
              workspaceFolder.uri.fsPath,
              fsLayer.getBranchDir(),
            );
            if (diff.allChanged.length === 0) {
              void vscode.window.showWarningMessage('No workspace changes to push.');
              return;
            }
            stagedPaths = diff.allChanged;
            autoStaged = true;
          } else {
            stagedPaths = staged.map(s => s.path);
          }

          // Permission check: locked branch (BRANCH-04)
          const branch = branchProvider.getActiveBranchName();
          const branchInfo = branchManager.getBranch(branch);
          if (branchInfo?.locked) {
            const canPush = branchInfo.lockedPushers?.includes(currentMemberId) ?? false;
            if (!canPush && currentMemberId !== hostMemberId) {
              void vscode.window.showErrorMessage(`Branch "${branch}" is locked. You do not have push access.`);
              return;
            }
          }
          // Permission check: branch restrictions (BRANCH-05)
          if (!permissions.canPushToBranch(currentMemberId, branch)) {
            void vscode.window.showErrorMessage(`You do not have permission to push to branch "${branch}".`);
            return;
          }

          const summary = await pushService.generateSummary(stagedPaths);

          // PUSH-03: file-level affected members from the host's MemberTrackingMap.
          // We only have the live MemberTrackingMap on the host side, so this
          // section is a no-op for non-host members (host-pushes-only is the
          // v1 model; clients will surface their own overlap on push-received).
          let affectedInfo = '';
          if (activeHost) {
            const tracking = activeHost.getMemberTracking();
            const names = activeHost.getMemberNames();
            const affected = pushService.computeAffectedMembers(
              stagedPaths,
              tracking,
              names,
              currentMemberId,
            );
            if (affected.length > 0) {
              affectedInfo = '\n\nMay affect:';
              for (const a of affected) {
                affectedInfo += `\n  - ${a.displayName}: ${a.overlappingFiles.join(', ')}`;
              }
            }
          }

          const fileList = summary.files.map(f =>
            `${f.status === 'added' ? '+' : f.status === 'deleted' ? '-' : '~'} ${f.relativePath} (+${f.addedLines} -${f.removedLines})`
          ).join('\n');

          const confirmation = await vscode.window.showInformationMessage(
            `Push ${stagedPaths.length} file(s) (+${summary.totalAdded} -${summary.totalRemoved} lines)`,
            { modal: true, detail: `${fileList}${affectedInfo}` },
            'Push',
          );
          if (confirmation !== 'Push') return;

          const message = await vscode.window.showInputBox({
            prompt: 'Enter push message',
            placeHolder: 'Enter push message...',
            validateInput: (v) => v.trim() ? null : 'Message is required',
          });

          if (!message) return;

          try {
            // Plan 05-05 (SC-2): executePush now returns BOTH the PushRecord
            // AND a per-file pre/post content map so SessionHost can feed the
            // AST analyzer without re-reading the branch snapshot.
            const { record, prePostByFile } = await pushService.executePush(message, stagedPaths, {
              id: currentMemberId,
              displayName: currentDisplayName,
            });

            // PUSH-09: mark the local push in the sync tracker (the local
            // user is by definition synced after their own push).
            syncTracker.onLocalPush(record.id);

            // Clear staged state. When the push was auto-staged via
            // WorkspaceDiffer (SC-3) there was nothing in the staged-set
            // to begin with; the guard documents intent (no-op either way).
            if (!autoStaged) {
              workspaceState.clearStaged();
              workspaceProvider!.clearStaged();
            }
            branchProvider.refresh();

            void vscode.window.showInformationMessage(
              `Pushed ${record.files.length} file(s) to ${record.branch}: "${message}"`,
            );

            // Broadcast to network if session active
            if (activeHost) {
              // Plan 04-15 (CR-02-NEW closure): broadcastPush returns the system
              // ChatRecord; echo it into the host's own ChatPanel since the host
              // does NOT receive its own broadcast over the wire (mirrors line 285
              // for user messages).
              // Plan 05-05 (SC-5): pass prePostByFile so the host can fire its
              // AST analyzer fire-and-forget after the sync broadcast completes
              // and emit a `chat-message-amend` when affectedSymbols are known.
              const systemRecord = activeHost.broadcastPush(record, prePostByFile);
              dispatchChatReceivedLocally(systemRecord);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Push failed';
            void vscode.window.showErrorMessage(`VersionCon: ${msg}`);
          }
        }),
      );

      // Show push history
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.showPushHistory', async () => {
          const records = pushHistory.getRecords();
          if (records.length === 0) {
            void vscode.window.showInformationMessage('No push history yet.');
            return;
          }

          const items = records.map(r => ({
            label: `${r.reverted ? '$(discard) ' : ''}${r.message}`,
            description: `${r.files.length} file(s) • ${r.memberDisplayName}`,
            detail: new Date(r.timestamp).toLocaleString(),
            record: r,
          }));

          const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a push to view options',
          });

          if (!selected) return;

          if (!selected.record.reverted) {
            const action = await vscode.window.showQuickPick(
              [{ label: 'Revert entire push' }, { label: 'Revert specific files' }],
              { placeHolder: `Actions for: ${selected.record.message}` },
            );

            if (action?.label === 'Revert entire push') {
              await vscode.commands.executeCommand('versioncon.revertPush', selected.record.id);
            } else if (action?.label === 'Revert specific files') {
              await vscode.commands.executeCommand('versioncon.revertPushFiles', selected.record.id);
            }
          }
        }),
      );

      // Revert an entire push
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.revertPush', async (pushId: string) => {
          const confirm = await vscode.window.showWarningMessage(
            'Revert this entire push? Files will be restored to their pre-push state.',
            { modal: true },
            'Revert',
          );
          if (confirm !== 'Revert') return;

          try {
            await pushService.revertPush(pushId);
            branchProvider.refresh();
            void vscode.window.showInformationMessage('Push reverted successfully.');

            if (activeHost) {
              const record = pushHistory.getRecord(pushId);
              if (record) {
                // Plan 04-15 (CR-02-NEW closure): echo system event into host's panel.
                const systemRecord = activeHost.broadcastRevert(record);
                dispatchChatReceivedLocally(systemRecord);
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Revert failed';
            void vscode.window.showErrorMessage(`VersionCon: ${msg}`);
          }
        }),
      );

      // Revert specific files from a push
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.revertPushFiles', async (pushId: string) => {
          const record = pushHistory.getRecord(pushId);
          if (!record) {
            void vscode.window.showErrorMessage('Push record not found.');
            return;
          }

          const items = record.files.map(f => ({
            label: f.relativePath,
            description: f.status,
            picked: false,
          }));

          const selected = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            placeHolder: 'Select files to revert',
          });

          if (!selected || selected.length === 0) return;

          try {
            await pushService.revertFiles(pushId, selected.map(s => s.label));
            branchProvider.refresh();

            // PUSH-08, SAFE-04: broadcast partial revert so the team gets the
            // same notification path as a full revert. The protocol-level
            // PushReverted carries the full list of originally-pushed files;
            // the message body of the notification only differs by intent.
            if (activeHost) {
              const fullRecord = pushHistory.getRecord(pushId);
              if (fullRecord) {
                // Plan 04-15 (CR-02-NEW closure): echo system event into host's panel.
                const systemRecord = activeHost.broadcastRevert(fullRecord);
                dispatchChatReceivedLocally(systemRecord);
              }
            }

            void vscode.window.showInformationMessage(`Reverted ${selected.length} file(s).`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Revert failed';
            void vscode.window.showErrorMessage(`VersionCon: ${msg}`);
          }
        }),
      );

      // Create branch
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.createBranch', async () => {
          // Permission check: branch creation (BRANCH-02)
          if (!permissions.canCreateBranch(currentMemberId)) {
            void vscode.window.showErrorMessage('You do not have permission to create branches. Ask the admin to grant access.');
            return;
          }

          const name = await vscode.window.showInputBox({
            prompt: 'Enter new branch name',
            placeHolder: 'feature-xyz',
            validateInput: (v) => /^[a-zA-Z0-9_-]+$/.test(v) ? null : 'Alphanumeric, hyphens, and underscores only',
          });
          if (!name) return;

          try {
            const activeBranch = await branchManager.getActiveBranch();
            const info = await branchManager.createBranch(name, activeBranch, currentMemberId);
            // BRANCH-03: refresh all-branches view on local create
            branchListProvider.refresh();
            void vscode.window.showInformationMessage(`Branch "${name}" created from "${activeBranch}".`);

            if (activeHost) {
              // Plan 04-15 (CR-02-NEW closure): echo system event into host's panel.
              const systemRecord = activeHost.broadcastBranchCreated(info);
              dispatchChatReceivedLocally(systemRecord);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to create branch';
            void vscode.window.showErrorMessage(`VersionCon: ${msg}`);
          }
        }),
      );

      // Switch branch
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.switchBranch', async () => {
          const branches = branchManager.listBranches();
          const currentBranch = await branchManager.getActiveBranch();

          const items = branches.map(b => ({
            label: b.name,
            description: b.name === currentBranch ? '(active)' : '',
          }));

          const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select branch to switch to',
          });

          if (!selected || selected.label === currentBranch) return;

          await branchManager.switchBranch(selected.label);
          const newDir = await branchManager.getActiveBranchDir();
          fsLayer.setBranchDir(newDir);
          branchProvider.setBranchDir(newDir);
          branchProvider.setActiveBranchName(selected.label);
          branchProvider.refresh();
          // BRANCH-03: update active marker in all-branches view
          branchListProvider.setActiveBranchName(selected.label);
          // Phase 4: re-mirror branch + re-broadcast presence with the new branch
          // so the divergence indicator + remote members' panels stay in sync.
          currentBranchName = selected.label;
          presenceTreeProvider?.setCurrentBranch(selected.label);
          // Phase 4 (Plan 04-11): chat-log is per-branch; rebuild for the new
          // branch and re-wire into the host so chat-message persistence +
          // chat-history replay target the right file.
          activeChatLog = new ChatLog(newDir);
          await activeChatLog.load();
          if (activeHost) {
            activeHost.setChatLog(activeChatLog, selected.label);
          }
          // Phase 6 Plan 06-04: review store is per-branch too — rebuild for
          // the new branch and re-wire into the host.
          activeReviewStore = new ReviewStore(versionconDir);
          await activeReviewStore.load(selected.label);
          if (activeHost) {
            activeHost.setReviewStore(activeReviewStore, selected.label);
          }
          if (reviewState) {
            reviewState.applyStateSync(
              selected.label,
              activeReviewStore.getAll().filter(r => r.branch === selected.label),
            );
          }
          sendPresenceUpdate(vscode.window.activeTextEditor);
          void vscode.window.showInformationMessage(`Switched to branch "${selected.label}".`);
        }),
      );

      // Delete branch
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.deleteBranch', async () => {
          const branches = branchManager.listBranches();
          const currentBranch = await branchManager.getActiveBranch();
          const deletable = branches.filter(b => b.name !== 'main' && b.name !== currentBranch);

          if (deletable.length === 0) {
            void vscode.window.showInformationMessage('No branches available to delete.');
            return;
          }

          const selected = await vscode.window.showQuickPick(
            deletable.map(b => ({ label: b.name })),
            { placeHolder: 'Select branch to delete' },
          );

          if (!selected) return;

          const confirm = await vscode.window.showWarningMessage(
            `Delete branch "${selected.label}"? This cannot be undone.`,
            { modal: true },
            'Delete',
          );
          if (confirm !== 'Delete') return;

          try {
            await branchManager.deleteBranch(selected.label);
            // BRANCH-03: refresh all-branches view on delete
            branchListProvider.refresh();
            void vscode.window.showInformationMessage(`Branch "${selected.label}" deleted.`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to delete branch';
            void vscode.window.showErrorMessage(`VersionCon: ${msg}`);
          }
        }),
      );

      // Merge branch
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.mergeBranch', async () => {
          const branches = branchManager.listBranches();

          const sourceItem = await vscode.window.showQuickPick(
            branches.map(b => ({ label: b.name })),
            { placeHolder: 'Select source branch (merge FROM)' },
          );
          if (!sourceItem) return;

          const targetItems = branches.filter(b => b.name !== sourceItem.label);
          const targetItem = await vscode.window.showQuickPick(
            targetItems.map(b => ({ label: b.name })),
            { placeHolder: 'Select target branch (merge INTO)' },
          );
          if (!targetItem) return;

          // Check merge permission for main
          if (targetItem.label === 'main' && !permissions.canMergeToMain(currentMemberId)) {
            void vscode.window.showErrorMessage('You do not have permission to merge into main.');
            return;
          }

          // Phase 6 Plan 06-05 — requireReview gate. When target.requireReview
          // is true AND the source branch's most-recent push lacks an
          // approving ReviewRequest, block the merge with a non-modal error
          // toast AND fire a system chat event so the team sees the rejection.
          if (activePushHistoryFull) {
            const gate = await checkRequireReviewGate(
              sourceItem.label, targetItem.label,
              { branchManager, pushHistory: activePushHistoryFull, reviewState },
            );
            if (!gate.allow) {
              void vscode.window.showErrorMessage(`VersionCon: ${gate.reason}`);
              if (activeHost) {
                activeHost.appendAndBroadcastSystemEvent(
                  'review-resolved',
                  `Merge blocked: needs review approval — ${sourceItem.label} → ${targetItem.label}`,
                  Date.now(),
                  { branch: targetItem.label },
                  currentSelfMemberId,
                  currentSelfDisplayName,
                );
              }
              return;
            }
          }

          const confirm = await vscode.window.showWarningMessage(
            `Merge "${sourceItem.label}" into "${targetItem.label}"?`,
            { modal: true },
            'Merge',
          );
          if (confirm !== 'Merge') return;

          try {
            const sourceDir = path.join(versionconDir, 'branches', sourceItem.label);
            const targetDir = path.join(versionconDir, 'branches', targetItem.label);

            // Copy all files from source to target (simple overwrite merge)
            const filePaths = await fsLayer.collectFilePaths(sourceDir, '');
            for (const filePath of filePaths) {
              const src = path.join(sourceDir, filePath);
              const dest = path.join(targetDir, filePath);
              await fsPromises.mkdir(path.dirname(dest), { recursive: true });
              await fsPromises.copyFile(src, dest);
            }

            branchProvider.refresh();
            void vscode.window.showInformationMessage(
              `Merged "${sourceItem.label}" into "${targetItem.label}" (${filePaths.length} files).`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Merge failed';
            void vscode.window.showErrorMessage(`VersionCon: ${msg}`);
          }
        }),
      );

      // Phase 6 Plan 06-05 — versioncon.setBranchRequireReview admin command.
      // Toggles BranchInfo.requireReview per-branch. Admin-gated via
      // permissions.canCreateBranch (the v1 admin proxy per 06-SPEC.md
      // frontmatter line 15). Persists via BranchManager.setRequireReview
      // through the existing saveMetadata path.
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.setBranchRequireReview', async () => {
          // Admin gate — canCreateBranch is the v1 admin proxy (06-SPEC.md).
          if (!permissions.canCreateBranch(currentMemberId)) {
            void vscode.window.showErrorMessage(
              'VersionCon: Only admins can change the require-review setting.',
            );
            return;
          }
          const branches = branchManager.listBranches();
          if (branches.length === 0) {
            void vscode.window.showInformationMessage('No branches available.');
            return;
          }
          const branchItem = await vscode.window.showQuickPick(
            branches.map(b => ({
              label: b.name,
              description: b.requireReview
                ? '(currently requires review)'
                : '(no review required)',
            })),
            { placeHolder: 'Select a branch' },
          );
          if (!branchItem) return;
          const choice = await vscode.window.showQuickPick(
            [
              { label: 'Yes — require review before merging into this branch', value: true },
              { label: 'No  — allow merges without review',                    value: false },
            ],
            { placeHolder: `Require review for merges into "${branchItem.label}"?` },
          );
          if (!choice) return;
          try {
            await branchManager.setRequireReview(branchItem.label, choice.value);
            if (activeBranchListProvider) activeBranchListProvider.refresh();
            void vscode.window.showInformationMessage(
              `VersionCon: ${branchItem.label} ${
                choice.value ? 'now requires' : 'no longer requires'
              } review before merges.`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to update require-review';
            void vscode.window.showErrorMessage(`VersionCon: ${msg}`);
          }
        }),
      );

      // Quick merge: copy specific files from one branch to another (BRANCH-07)
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.quickMergeFiles', async () => {
          const branches = branchManager.listBranches();
          if (branches.length < 2) {
            void vscode.window.showInformationMessage('Need at least two branches to merge files.');
            return;
          }

          // 1. Pick source branch
          const sourceItem = await vscode.window.showQuickPick(
            branches.map(b => ({ label: b.name })),
            { placeHolder: 'Source branch (copy files FROM)' },
          );
          if (!sourceItem) return;

          // 2. Pick target branch (cannot equal source)
          const targetItem = await vscode.window.showQuickPick(
            branches.filter(b => b.name !== sourceItem.label).map(b => ({ label: b.name })),
            { placeHolder: 'Target branch (copy files TO)' },
          );
          if (!targetItem) return;

          // 3. Permission check — same as full merge: if target is main, require canMergeToMain
          if (targetItem.label === 'main' && !permissions.canMergeToMain(currentMemberId)) {
            void vscode.window.showErrorMessage('You do not have permission to merge into main.');
            return;
          }
          // 3b. Lock check — refuse if target branch is locked and user is not in lockedPushers
          const targetInfo = branchManager.getBranch(targetItem.label);
          if (targetInfo?.locked) {
            const allowed = targetInfo.lockedPushers?.includes(currentMemberId) ?? false;
            if (!allowed && currentMemberId !== hostMemberId) {
              void vscode.window.showErrorMessage(`Branch "${targetItem.label}" is locked. You cannot merge into it.`);
              return;
            }
          }

          // 3c. Phase 6 Plan 06-05 — requireReview gate (same shape as the
          // full-merge mergeBranch entry point above).
          if (activePushHistoryFull) {
            const gate = await checkRequireReviewGate(
              sourceItem.label, targetItem.label,
              { branchManager, pushHistory: activePushHistoryFull, reviewState },
            );
            if (!gate.allow) {
              void vscode.window.showErrorMessage(`VersionCon: ${gate.reason}`);
              if (activeHost) {
                activeHost.appendAndBroadcastSystemEvent(
                  'review-resolved',
                  `Merge blocked: needs review approval — ${sourceItem.label} → ${targetItem.label}`,
                  Date.now(),
                  { branch: targetItem.label },
                  currentSelfMemberId,
                  currentSelfDisplayName,
                );
              }
              return;
            }
          }

          // 4. Enumerate source files and let the user multi-select
          const sourceDir = path.join(versionconDir, 'branches', sourceItem.label);
          const filePaths = await fsLayer.collectFilePaths(sourceDir, '');
          if (filePaths.length === 0) {
            void vscode.window.showInformationMessage(`Source branch "${sourceItem.label}" has no files.`);
            return;
          }

          const picks = await vscode.window.showQuickPick(
            filePaths.map(p => ({ label: p, picked: false })),
            {
              placeHolder: `Select files to copy from "${sourceItem.label}" to "${targetItem.label}"`,
              canPickMany: true,
            },
          );
          if (!picks || picks.length === 0) return;

          // 5. Confirm
          const confirm = await vscode.window.showWarningMessage(
            `Copy ${picks.length} file(s) from "${sourceItem.label}" to "${targetItem.label}"? Existing files in target will be overwritten.`,
            { modal: true },
            'Copy',
          );
          if (confirm !== 'Copy') return;

          // 6. Execute
          try {
            const targetDir = path.join(versionconDir, 'branches', targetItem.label);
            for (const pick of picks) {
              const src = path.join(sourceDir, pick.label);
              const dest = path.join(targetDir, pick.label);
              await fsPromises.mkdir(path.dirname(dest), { recursive: true });
              await fsPromises.copyFile(src, dest);
            }
            branchProvider.refresh();
            if (activeBranchListProvider) activeBranchListProvider.refresh();
            void vscode.window.showInformationMessage(
              `Quick-merged ${picks.length} file(s) from "${sourceItem.label}" into "${targetItem.label}".`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Quick merge failed';
            void vscode.window.showErrorMessage(`VersionCon: ${msg}`);
          }
        }),
      );

      // Structured merge: full-branch merge with per-file diff walkthrough (BRANCH-08)
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.structuredMergeBranch', async () => {
          const branches = branchManager.listBranches();
          if (branches.length < 2) {
            void vscode.window.showInformationMessage('Need at least two branches to merge.');
            return;
          }

          const sourceItem = await vscode.window.showQuickPick(
            branches.map(b => ({ label: b.name })),
            { placeHolder: 'Source branch (merge FROM)' },
          );
          if (!sourceItem) return;

          const targetItem = await vscode.window.showQuickPick(
            branches.filter(b => b.name !== sourceItem.label).map(b => ({ label: b.name })),
            { placeHolder: 'Target branch (merge INTO)' },
          );
          if (!targetItem) return;

          // Permission + lock checks (same as quick merge)
          if (targetItem.label === 'main' && !permissions.canMergeToMain(currentMemberId)) {
            void vscode.window.showErrorMessage('You do not have permission to merge into main.');
            return;
          }
          const targetInfo = branchManager.getBranch(targetItem.label);
          if (targetInfo?.locked) {
            const allowed = targetInfo.lockedPushers?.includes(currentMemberId) ?? false;
            if (!allowed && currentMemberId !== hostMemberId) {
              void vscode.window.showErrorMessage(`Branch "${targetItem.label}" is locked. You cannot merge into it.`);
              return;
            }
          }

          // Phase 6 Plan 06-05 — requireReview gate (same shape as the other
          // two merge entry points; gate runs BEFORE any file enumeration).
          if (activePushHistoryFull) {
            const gate = await checkRequireReviewGate(
              sourceItem.label, targetItem.label,
              { branchManager, pushHistory: activePushHistoryFull, reviewState },
            );
            if (!gate.allow) {
              void vscode.window.showErrorMessage(`VersionCon: ${gate.reason}`);
              if (activeHost) {
                activeHost.appendAndBroadcastSystemEvent(
                  'review-resolved',
                  `Merge blocked: needs review approval — ${sourceItem.label} → ${targetItem.label}`,
                  Date.now(),
                  { branch: targetItem.label },
                  currentSelfMemberId,
                  currentSelfDisplayName,
                );
              }
              return;
            }
          }

          const sourceDir = path.join(versionconDir, 'branches', sourceItem.label);
          const targetDir = path.join(versionconDir, 'branches', targetItem.label);
          const sourcePaths = await fsLayer.collectFilePaths(sourceDir, '');
          const targetPaths = new Set(await fsLayer.collectFilePaths(targetDir, ''));

          // Build per-file walkthrough with stats: 'added' (only in source) or 'modified' (in both)
          type Walk = { path: string; status: 'added' | 'modified'; addedLines: number; removedLines: number };
          const walk: Walk[] = [];
          for (const p of sourcePaths) {
            const srcContent = await fsPromises
              .readFile(path.join(sourceDir, p), 'utf-8')
              .catch(() => '');
            if (targetPaths.has(p)) {
              const tgtContent = await fsPromises
                .readFile(path.join(targetDir, p), 'utf-8')
                .catch(() => '');
              if (srcContent === tgtContent) continue; // identical, skip
              const srcLines = srcContent.split('\n').length;
              const tgtLines = tgtContent.split('\n').length;
              walk.push({
                path: p,
                status: 'modified',
                addedLines: Math.max(0, srcLines - tgtLines),
                removedLines: Math.max(0, tgtLines - srcLines),
              });
            } else {
              walk.push({
                path: p,
                status: 'added',
                addedLines: srcContent.split('\n').length,
                removedLines: 0,
              });
            }
          }

          if (walk.length === 0) {
            void vscode.window.showInformationMessage(
              `No differences between "${sourceItem.label}" and "${targetItem.label}". Nothing to merge.`,
            );
            return;
          }

          // Show structured walkthrough as a multi-select QuickPick. Each item's
          // detail string contains the diff stats. The user can preview any file
          // by selecting it. Confirm-to-merge is a final modal.
          const items = walk.map(w => ({
            label: `${w.status === 'added' ? '+' : '~'} ${w.path}`,
            description: `+${w.addedLines} -${w.removedLines}`,
            detail: w.status === 'added' ? 'NEW in source' : 'MODIFIED in source',
            path: w.path,
          }));

          const reviewed = await vscode.window.showQuickPick(items, {
            placeHolder: `Merge preview: ${walk.length} file(s) will change. Select files to preview diff (multi-select), or press Esc to skip preview.`,
            canPickMany: true,
          });

          // Open vscode.diff for each selected file BEFORE confirming the merge.
          if (reviewed && reviewed.length > 0) {
            for (const r of reviewed) {
              const srcUri = vscode.Uri.file(path.join(sourceDir, r.path));
              const tgtUri = vscode.Uri.file(path.join(targetDir, r.path));
              await vscode.commands.executeCommand(
                'vscode.diff',
                tgtUri, srcUri,
                `${r.path} (${targetItem.label} ↔ ${sourceItem.label})`,
              );
            }
          }

          // Final confirmation modal
          const confirm = await vscode.window.showWarningMessage(
            `Merge "${sourceItem.label}" into "${targetItem.label}"? ${walk.length} file(s) will be overwritten.`,
            { modal: true },
            'Merge',
          );
          if (confirm !== 'Merge') return;

          try {
            for (const w of walk) {
              const src = path.join(sourceDir, w.path);
              const dest = path.join(targetDir, w.path);
              await fsPromises.mkdir(path.dirname(dest), { recursive: true });
              await fsPromises.copyFile(src, dest);
            }
            branchProvider.refresh();
            if (activeBranchListProvider) activeBranchListProvider.refresh();
            void vscode.window.showInformationMessage(
              `Merged "${sourceItem.label}" into "${targetItem.label}" (${walk.length} files changed).`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Structured merge failed';
            void vscode.window.showErrorMessage(`VersionCon: ${msg}`);
          }
        }),
      );

      // Manage branch permissions (host-only)
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.manageBranchPermissions', async () => {
          const action = await vscode.window.showQuickPick([
            { label: 'Set merge policy', description: 'Who can merge to main' },
            { label: 'Lock a branch', description: 'Restrict push access' },
            { label: 'Unlock a branch', description: 'Remove push restrictions' },
            { label: 'Grant branch creation', description: 'Allow a member to create branches' },
            { label: 'Revoke branch creation', description: 'Remove branch creation permission' },
            { label: 'Restrict branch access', description: 'Limit who can push to a branch' },
            { label: 'Clear branch restrictions', description: 'Remove push restrictions from a branch' },
          ], { placeHolder: 'Branch permission management' });

          if (!action) return;

          try {
            if (action.label === 'Set merge policy') {
              const policy = await vscode.window.showQuickPick([
                { label: 'open', description: 'Anyone can merge' },
                { label: 'limited', description: 'Only approved members' },
                { label: 'restricted', description: 'Host only' },
              ], { placeHolder: 'Select merge policy' });

              if (policy) {
                await permissions.setMergePolicy(policy.label as 'open' | 'limited' | 'restricted');
                void vscode.window.showInformationMessage(`Merge policy set to: ${policy.label}`);
              }
            } else if (action.label === 'Lock a branch') {
              const branches = branchManager.listBranches().filter(b => !b.locked);
              if (branches.length === 0) {
                void vscode.window.showInformationMessage('All branches are already locked.');
                return;
              }
              const selected = await vscode.window.showQuickPick(
                branches.map(b => ({ label: b.name })),
                { placeHolder: 'Select branch to lock' },
              );
              if (selected) {
                await branchManager.lockBranch(selected.label);
                // BRANCH-03: refresh all-branches view on lock
                branchListProvider.refresh();
                void vscode.window.showInformationMessage(`Branch "${selected.label}" locked.`);

                if (activeHost) {
                  activeHost.broadcastBranchLocked(selected.label, true);
                }
              }
            } else if (action.label === 'Unlock a branch') {
              const branches = branchManager.listBranches().filter(b => b.locked);
              if (branches.length === 0) {
                void vscode.window.showInformationMessage('No branches are locked.');
                return;
              }
              const selected = await vscode.window.showQuickPick(
                branches.map(b => ({ label: b.name })),
                { placeHolder: 'Select branch to unlock' },
              );
              if (selected) {
                await branchManager.unlockBranch(selected.label);
                // BRANCH-03: refresh all-branches view on unlock
                branchListProvider.refresh();
                void vscode.window.showInformationMessage(`Branch "${selected.label}" unlocked.`);

                if (activeHost) {
                  activeHost.broadcastBranchLocked(selected.label, false);
                }
              }
            } else if (action.label === 'Grant branch creation') {
              // BRANCH-01: Admin grants branch creation to a member
              const members = activeHost?.getMembers().filter(m => m.role !== 'host') ?? [];
              let memberId: string | undefined;
              if (members.length > 0) {
                const picked = await vscode.window.showQuickPick(
                  members.map(m => ({ label: m.displayName, description: m.id, memberId: m.id })),
                  { placeHolder: 'Select member to grant branch creation' },
                );
                memberId = picked?.memberId;
              } else {
                memberId = await vscode.window.showInputBox({
                  prompt: 'Enter member ID to grant branch creation',
                  placeHolder: 'member-id',
                  validateInput: (v) => v.trim() ? null : 'Member ID required',
                });
              }
              if (!memberId) return;
              await permissions.grantBranchCreation(memberId);
              void vscode.window.showInformationMessage(`Granted branch creation to "${memberId}".`);
            } else if (action.label === 'Revoke branch creation') {
              // BRANCH-01: Admin revokes branch creation from a member
              const granted = permissions.getData().canCreateBranch;
              if (granted.length === 0) {
                void vscode.window.showInformationMessage('No members have branch creation granted.');
                return;
              }
              const selected = await vscode.window.showQuickPick(
                granted.map(id => ({ label: id })),
                { placeHolder: 'Select member to revoke branch creation' },
              );
              if (!selected) return;
              await permissions.revokeBranchCreation(selected.label);
              void vscode.window.showInformationMessage(`Revoked branch creation from "${selected.label}".`);
            } else if (action.label === 'Restrict branch access') {
              // BRANCH-05: Admin restricts a branch to specific members
              const branches = branchManager.listBranches();
              if (branches.length === 0) {
                void vscode.window.showInformationMessage('No branches available.');
                return;
              }
              const branchPick = await vscode.window.showQuickPick(
                branches.map(b => ({ label: b.name })),
                { placeHolder: 'Select branch to restrict' },
              );
              if (!branchPick) return;

              // Multi-select members from session, fallback to InputBox
              const members = activeHost?.getMembers().filter(m => m.role !== 'host') ?? [];
              let allowedMembers: string[];
              if (members.length > 0) {
                const picked = await vscode.window.showQuickPick(
                  members.map(m => ({ label: m.displayName, description: m.id, memberId: m.id })),
                  { placeHolder: 'Select allowed members (multi-select)', canPickMany: true },
                );
                if (!picked || picked.length === 0) return;
                allowedMembers = picked.map(p => p.memberId);
              } else {
                const csv = await vscode.window.showInputBox({
                  prompt: `Comma-separated member IDs allowed to push to "${branchPick.label}"`,
                  placeHolder: 'member-1, member-2',
                  validateInput: (v) => v.trim() ? null : 'At least one member ID required',
                });
                if (!csv) return;
                allowedMembers = csv.split(',').map(s => s.trim()).filter(Boolean);
                if (allowedMembers.length === 0) return;
              }
              await permissions.restrictBranch(branchPick.label, allowedMembers);
              void vscode.window.showInformationMessage(
                `Branch "${branchPick.label}" restricted to ${allowedMembers.length} member(s).`,
              );
            } else if (action.label === 'Clear branch restrictions') {
              const restrictions = permissions.getData().branchRestrictions;
              const restrictedNames = Object.keys(restrictions);
              if (restrictedNames.length === 0) {
                void vscode.window.showInformationMessage('No branches have push restrictions.');
                return;
              }
              const selected = await vscode.window.showQuickPick(
                restrictedNames.map(n => ({ label: n, description: `${restrictions[n].length} allowed member(s)` })),
                { placeHolder: 'Select branch to clear restrictions for' },
              );
              if (!selected) return;
              await permissions.clearRestrictions(selected.label);
              void vscode.window.showInformationMessage(
                `Cleared push restrictions on "${selected.label}".`,
              );
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Operation failed';
            void vscode.window.showErrorMessage(`VersionCon: ${msg}`);
          }
        }),
      );

      // Create a new file in workspace
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.addNewFileToWorkspace', async () => {
          const relativePath = await vscode.window.showInputBox({
            prompt: 'Enter file path (e.g. src/utils/helper.ts)',
            placeHolder: 'src/newfile.ts',
          });
          if (!relativePath) return;

          try {
            const fullPath = path.join(workspaceFolder.uri.fsPath, relativePath);
            await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
            await fsPromises.writeFile(fullPath, '', { flag: 'wx' }); // fail if exists
            workspaceProvider!.trackFile(relativePath);
            void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fullPath));
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to create file';
            void vscode.window.showErrorMessage(`VersionCon: ${msg}`);
          }
        }),
      );

      // --- Phase 4.3 Wave 4 (SC-6 / T-04.3-02 / T-04.3-03 / T-04.3-04): cloud bridge ---
      // versioncon.exportToGitRemote ships the active branch dir to a real git
      // remote (GitHub, GitLab, local bare repo). Host-only via activeHost gate;
      // admin-gated via permissions.canCreateBranch (host always passes per
      // BranchPermissions.canCreateBranch host-bypass). All git invocations go
      // through GitBridge → child_process.spawn with shell:false + argv array.
      // T-04.3-02 mitigation: confirmation modal before any push fires.
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.exportToGitRemote', async () => {
          // T-04.3-04 layer 1: host-only. Members cannot trigger cloud export.
          if (!activeHost) {
            void vscode.window.showErrorMessage(
              'VersionCon: cloud export is host-only. Start a session as host first.',
            );
            return;
          }
          // T-04.3-04 layer 2: admin proxy via canCreateBranch (host bypasses;
          // members need an explicit grant). Same gate used by createBranch /
          // mergeBranch — see BranchPermissions.canCreateBranch host-bypass.
          if (!permissions.canCreateBranch(currentMemberId)) {
            void vscode.window.showErrorMessage(
              'VersionCon: cloud export requires admin permission.',
            );
            return;
          }

          const bridge = new GitBridge();

          // T-04.3-03: URL is validated against the allowlist regex BEFORE it
          // ever reaches spawn. validateInput rejects anything non-conforming.
          const url = await vscode.window.showInputBox({
            prompt: 'Remote URL (https://, git@host:, or file://)',
            placeHolder: 'https://github.com/you/your-repo.git',
            validateInput: (v) =>
              bridge.validateUrl(v.trim())
                ? null
                : 'Invalid URL — must match https://, git@host:, or file:// allowlist',
          });
          if (!url) return;

          const activeBranch = await branchManager.getActiveBranch();

          // T-04.3-03: branch name validated against allowlist before spawn.
          const branchOnRemote = await vscode.window.showInputBox({
            prompt: 'Branch name on remote',
            value: activeBranch,
            validateInput: (v) =>
              bridge.validateBranchName(v.trim())
                ? null
                : 'Invalid branch name — alphanumerics, dots, slashes, dashes, underscores; max 128 chars',
          });
          if (!branchOnRemote) return;

          // Commit message is passed via spawn argv as a discrete element, so
          // shell metacharacters in the message are harmless. No regex needed
          // beyond non-empty.
          const message = await vscode.window.showInputBox({
            prompt: 'Commit message',
            placeHolder: 'Initial export from VersionCon',
            validateInput: (v) => (v.trim() ? null : 'Message is required'),
          });
          if (!message) return;

          // Build the branchDir path the export will run inside.
          const branchDir = path.join(versionconDir, 'branches', activeBranch);

          // Count files (best-effort, surface in the confirmation modal).
          let fileCount = 0;
          try {
            const entries = await fsPromises.readdir(branchDir, { withFileTypes: true });
            fileCount = entries.filter((e) => e.isFile()).length;
          } catch {
            /* dir missing — fileCount stays 0 */
          }

          // T-04.3-02: explicit confirmation modal before the push. User must
          // click Export. URL + branch + file count + commit message all
          // surfaced so the user has full context before code leaves the LAN.
          const confirm = await vscode.window.showInformationMessage(
            `Push branch "${activeBranch}" to ${url.trim()}?`,
            {
              modal: true,
              detail: `Branch on remote: ${branchOnRemote.trim()}\nFiles: ${fileCount}\nCommit message: "${message.trim()}"`,
            },
            'Export',
          );
          if (confirm !== 'Export') return;

          const channel = getGitBridgeOutputChannel(context);
          channel.show(true);
          channel.appendLine(`--- Export to ${url.trim()} (${new Date().toISOString()}) ---`);

          try {
            await bridge.exportToRemote({
              branchDir,
              remoteUrl: url.trim(),
              branchOnRemote: branchOnRemote.trim(),
              commitMessage: message.trim(),
              onOutput: (line) => channel.appendLine(line),
            });
            void vscode.window.showInformationMessage(
              `VersionCon: exported "${activeBranch}" to ${url.trim()}.`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            channel.appendLine(`ERROR: ${msg}`);
            void vscode.window.showErrorMessage(`VersionCon: export failed — ${msg}`);
          }
        }),
      );

      // versioncon.importFromGitRemote clones a remote into a fresh
      // .versioncon/branches/{newName}/ dir and registers it via
      // BranchManager.registerExternalBranch. Same host-only + admin gate as
      // export. T-04.3-02 confirmation modal mirrors export for symmetry.
      // T-04.3-13 mitigation lives inside GitBridge.importFromRemote (strips
      // .git/ after clone so malicious hooks can't fire).
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.importFromGitRemote', async () => {
          // T-04.3-04 layer 1: host-only.
          if (!activeHost) {
            void vscode.window.showErrorMessage(
              'VersionCon: cloud import is host-only. Start a session as host first.',
            );
            return;
          }
          // T-04.3-04 layer 2: admin proxy.
          if (!permissions.canCreateBranch(currentMemberId)) {
            void vscode.window.showErrorMessage(
              'VersionCon: cloud import requires admin permission.',
            );
            return;
          }

          const bridge = new GitBridge();

          const url = await vscode.window.showInputBox({
            prompt: 'Remote URL to clone',
            placeHolder: 'https://github.com/you/your-repo.git',
            validateInput: (v) =>
              bridge.validateUrl(v.trim()) ? null : 'Invalid URL',
          });
          if (!url) return;

          const branchOnRemote = await vscode.window.showInputBox({
            prompt: 'Branch on remote to clone',
            value: 'main',
            validateInput: (v) =>
              bridge.validateBranchName(v.trim()) ? null : 'Invalid branch name',
          });
          if (!branchOnRemote) return;

          // Collision check uses listBranches() so the validateInput call
          // surfaces the existing-branch error inline. Snapshot up-front;
          // the set is small and the IIFE owns the only writer.
          const existing = new Set(branchManager.listBranches().map((b) => b.name));
          const newName = await vscode.window.showInputBox({
            prompt: 'New VersionCon branch name for the imported content',
            validateInput: (v) => {
              const trimmed = v.trim();
              if (!bridge.validateBranchName(trimmed)) return 'Invalid branch name';
              if (existing.has(trimmed)) return `Branch "${trimmed}" already exists locally`;
              return null;
            },
          });
          if (!newName) return;

          // T-04.3-02: confirmation modal before clone. Symmetric with export
          // even though clone is import-side; the SPEC requires explicit
          // user consent before a remote address is contacted.
          const confirm = await vscode.window.showInformationMessage(
            `Clone ${url.trim()} into branch "${newName.trim()}"?`,
            {
              modal: true,
              detail: `Remote branch: ${branchOnRemote.trim()}\nDestination: .versioncon/branches/${newName.trim()}/`,
            },
            'Import',
          );
          if (confirm !== 'Import') return;

          const channel = getGitBridgeOutputChannel(context);
          channel.show(true);
          channel.appendLine(`--- Import from ${url.trim()} (${new Date().toISOString()}) ---`);

          const destDir = path.join(versionconDir, 'branches', newName.trim());

          try {
            await bridge.importFromRemote({
              remoteUrl: url.trim(),
              branchOnRemote: branchOnRemote.trim(),
              destDir,
              onOutput: (line) => channel.appendLine(line),
            });
            await branchManager.registerExternalBranch(newName.trim(), currentMemberId);
            branchListProvider.refresh();
            void vscode.window.showInformationMessage(
              `VersionCon: imported branch "${newName.trim()}".`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            channel.appendLine(`ERROR: ${msg}`);
            // Best-effort cleanup so a retry can run cleanly. Swallow rm
            // errors — there may be nothing to remove if clone failed
            // before destDir was created.
            await fsPromises.rm(destDir, { recursive: true, force: true }).catch(() => undefined);
            void vscode.window.showErrorMessage(`VersionCon: import failed — ${msg}`);
          }
        }),
      );

      // Refresh commands
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.refreshBranchTree', () => {
          branchProvider.refresh();
        }),
      );

      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.refreshWorkspaceTree', () => {
          workspaceProvider!.refresh();
        }),
      );

      // --- PUSH-10/11: Sync command ---
      // Real file pull. Walks the SyncTracker out-of-sync set, partitions into:
      //   * deleted-upstream -> branch path no longer exists; drop from set
      //   * no-local         -> file exists in branch but not in workspace -> silent copy
      //   * identical        -> branch and workspace bytes match -> silent clear
      //   * conflict         -> file exists in both, bytes differ -> per-file prompt:
      //                           Keep mine | Take branch | Show diff
      // After the loop, if the out-of-sync set is empty, mark fully synced.
      // If non-empty (the user kept some local edits), keep the warning on.
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.sync', async () => {
          const paths = syncTracker.getOutOfSyncPaths();
          if (paths.length === 0) {
            syncTracker.onSync();
            statusBarManager.setSyncWarning(false);
            branchProvider.refresh();
            void vscode.window.showInformationMessage('VersionCon: already in sync.');
            return;
          }

          const branchDir = fsLayer.getBranchDir();
          const projectRoot = fsLayer.getProjectRoot();
          let pulled = 0;
          let kept = 0;

          for (const rel of paths) {
            const branchPath = path.join(branchDir, rel);
            const workspacePath = path.join(projectRoot, rel);

            const branchExists = fs.existsSync(branchPath);
            const workspaceExists = fs.existsSync(workspacePath);

            // Case A: file no longer in branch (deleted upstream).
            // v1: drop from set so the user is not stuck. Workspace
            // deletion semantics are intentionally deferred.
            if (!branchExists) {
              syncTracker.clearPath(rel);
              continue;
            }

            // Case B: workspace has no local copy -> silent pull.
            if (!workspaceExists) {
              await fsLayer.copyFileToWorkspace(rel);
              syncTracker.clearPath(rel);
              pulled++;
              continue;
            }

            // Case C: both exist -> compare bytes.
            const [branchBuf, workspaceBuf] = await Promise.all([
              fsPromises.readFile(branchPath),
              fsPromises.readFile(workspacePath),
            ]);
            if (branchBuf.equals(workspaceBuf)) {
              syncTracker.clearPath(rel);
              continue;
            }

            // Case D: real conflict -> PUSH-11 per-file prompt.
            // Loop until the user picks Keep mine or Take branch (Show diff
            // re-prompts after the diff editor is opened).
            let resolved = false;
            while (!resolved) {
              const choice = await vscode.window.showInformationMessage(
                `Sync conflict: ${rel}`,
                {
                  modal: true,
                  detail: 'The branch has a different version of this file than your workspace. Choose how to resolve:',
                },
                'Keep mine',
                'Take branch',
                'Show diff',
              );
              if (choice === 'Take branch') {
                await fsLayer.copyFileToWorkspace(rel);
                syncTracker.clearPath(rel);
                pulled++;
                resolved = true;
              } else if (choice === 'Keep mine') {
                // PUSH-11: leave the file as-is in the workspace AND leave it
                // in the out-of-sync set so the user can come back to it.
                kept++;
                resolved = true;
              } else if (choice === 'Show diff') {
                const branchUri = vscode.Uri.file(branchPath);
                const workspaceUri = vscode.Uri.file(workspacePath);
                await vscode.commands.executeCommand(
                  'vscode.diff',
                  branchUri,
                  workspaceUri,
                  `${rel} (Branch ↔ Workspace)`,
                );
                // Loop back and re-prompt — user must still pick Keep / Take.
              } else {
                // Dismissed (Esc / X). PUSH-11: unresolved file stays in
                // the set; treat dismiss as Keep mine and move on.
                kept++;
                resolved = true;
              }
            }
          }

          const remaining = syncTracker.getOutOfSyncPaths().length;
          if (remaining === 0) {
            syncTracker.onSync();
            statusBarManager.setSyncWarning(false);
            void vscode.window.showInformationMessage(
              `VersionCon: synced ${pulled} file(s).`,
            );
          } else {
            void vscode.window.showWarningMessage(
              `VersionCon: synced ${pulled} file(s); kept ${kept} local. ${remaining} file(s) still out of sync.`,
            );
          }
          branchProvider.refresh();
        }),
      );

      // --- Phase 4.3 SC-4: workspace-diff–driven pull command ---
      // Distinct from versioncon.sync (which walks the SyncTracker out-of-sync
      // set after a remote push). vc.pull computes a fresh branch-vs-workspace
      // diff and copies the branch side into the workspace for any file that
      // is added/modified upstream. Conflicts reuse the PUSH-11 modal verbatim
      // (T-04.3-06 mitigation): same literals, same loop semantics, same options.
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.pull', async () => {
          const differ = new WorkspaceDiffer();
          const diff = await differ.diff(
            workspaceFolder.uri.fsPath,
            fsLayer.getBranchDir(),
          );
          const candidates = [...diff.added, ...diff.modified];
          if (candidates.length === 0) {
            void vscode.window.showInformationMessage(
              'VersionCon: workspace is already up to date with the branch.',
            );
            return;
          }

          const branchDir = fsLayer.getBranchDir();
          const projectRoot = fsLayer.getProjectRoot();
          let pulled = 0;
          let kept = 0;

          for (const rel of candidates) {
            const branchPath = path.join(branchDir, rel);
            const workspacePath = path.join(projectRoot, rel);
            const branchExists = fs.existsSync(branchPath);
            const workspaceExists = fs.existsSync(workspacePath);

            if (!branchExists) continue;

            // Case B (silent pull): workspace missing the file.
            if (!workspaceExists) {
              await fsLayer.copyFileToWorkspace(rel);
              pulled++;
              continue;
            }

            // Case C: both exist -> byte compare.
            const [bBuf, wBuf] = await Promise.all([
              fsPromises.readFile(branchPath),
              fsPromises.readFile(workspacePath),
            ]);
            if (bBuf.equals(wBuf)) continue;

            // Case D: real conflict -> reuse PUSH-11 modal.
            let resolved = false;
            while (!resolved) {
              const choice = await vscode.window.showInformationMessage(
                `Pull conflict: ${rel}`,
                {
                  modal: true,
                  detail: 'The branch has a different version of this file than your workspace. Choose how to resolve:',
                },
                'Keep mine',
                'Take branch',
                'Show diff',
              );
              if (choice === 'Take branch') {
                await fsLayer.copyFileToWorkspace(rel);
                pulled++;
                resolved = true;
              } else if (choice === 'Keep mine') {
                kept++;
                resolved = true;
              } else if (choice === 'Show diff') {
                const branchUri = vscode.Uri.file(branchPath);
                const workspaceUri = vscode.Uri.file(workspacePath);
                await vscode.commands.executeCommand(
                  'vscode.diff',
                  branchUri,
                  workspaceUri,
                  `${rel} (Branch ↔ Workspace)`,
                );
                // Loop and re-prompt — user must still pick Keep / Take.
              } else {
                // Dismissed (Esc / X) — treat as Keep mine and move on.
                kept++;
                resolved = true;
              }
            }
          }

          // vc.pull v1: branch-side deletions are NOT propagated to the
          // workspace — user must delete manually. Mirrors the sync handler's
          // deleted-upstream behavior (extension.ts above: branch missing →
          // drop from set, do not delete workspace file).
          void vscode.window.showInformationMessage(
            `VersionCon: pulled ${pulled} file(s); kept ${kept} local.`,
          );
          branchProvider.refresh();
        }),
      );

      // --- Phase 4.3 SC-5: versioncon.diff — workspace-wide QuickPick diff
      // Distinct from versioncon.previewDiff (per-file diff from the
      // workspaceTree context menu). versioncon.diff is the click target of
      // LocalChangesStatusBar and the new target of the cmd.diff alias —
      // it surfaces a QuickPick over ALL changed files; selecting one opens
      // vscode.diff between the branch ↔ workspace versions.
      //
      // The handler is intentionally lightweight: WorkspaceDiffer runs once
      // (no caching from the watcher refresh — those are separate calls so
      // the diff is always fresh against the active branch dir, even after
      // a switchBranch that the user did since the last watcher fire).
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.diff', async () => {
          const differ = new WorkspaceDiffer();
          const diff = await differ.diff(
            workspaceFolder.uri.fsPath,
            fsLayer.getBranchDir(),
          );
          if (diff.allChanged.length === 0) {
            void vscode.window.showInformationMessage('VersionCon: no local changes.');
            return;
          }
          // Status prefix per file ("A " added / "M " modified / "D " deleted)
          // mirrors familiar `git status -s` shorthand so the QuickPick reads
          // at a glance.
          const addedSet = new Set(diff.added);
          const deletedSet = new Set(diff.deleted);
          const items = diff.allChanged.map(rel => {
            const prefix = addedSet.has(rel) ? 'A ' : deletedSet.has(rel) ? 'D ' : 'M ';
            return { label: `${prefix}${rel}`, description: rel, rel };
          });
          const picked = await vscode.window.showQuickPick(items, {
            title: `VersionCon: ${diff.allChanged.length} local change(s)`,
            placeHolder: 'Pick a file to diff against branch',
            matchOnDescription: true,
          });
          if (!picked) return;
          // vscode.diff needs URIs. For added files the branch side doesn't
          // exist; vscode.diff renders the missing side as an empty document,
          // which is the desired UX (user sees the full added content on the
          // right side). Mirrors the per-file previewDiff command at line ~1480.
          const branchPath = path.join(fsLayer.getBranchDir(), picked.rel);
          const workspacePath = path.join(workspaceFolder.uri.fsPath, picked.rel);
          await vscode.commands.executeCommand(
            'vscode.diff',
            vscode.Uri.file(branchPath),
            vscode.Uri.file(workspacePath),
            `${picked.rel} (Branch ↔ Workspace)`,
          );
        }),
      );

      // --- PUSH-09: Modal block on debug start ---
      // The listener fires AFTER VS Code starts the session; if the user
      // picks Sync we stop the session and run sync. Otherwise the modal
      // interrupts but the session continues — VS Code API has no veto.
      context.subscriptions.push(
        vscode.debug.onDidStartDebugSession((session) => {
          if (syncTracker.isInSync()) return;
          void (async () => {
            const choice = await vscode.window.showInformationMessage(
              'Your workspace is out of sync with the latest branch state.',
              { modal: true, detail: 'You must Sync before debugging. Click Sync to stop the current debug session and pull the latest branch versions.' },
              'Sync',
            );
            if (choice !== 'Sync') return;
            await vscode.debug.stopDebugging(session);
            await vscode.commands.executeCommand('versioncon.sync');
          })();
        }),
      );

      // --- PUSH-09: Modal block on task start ---
      // v1 limit — VS Code does not expose a generic stop-task API, so the
      // task continues running while the modal is open. The block still
      // interrupts the user visibly; if they pick Sync they should also kill
      // the running task themselves.
      context.subscriptions.push(
        vscode.tasks.onDidStartTask(() => {
          if (syncTracker.isInSync()) return;
          void (async () => {
            const choice = await vscode.window.showInformationMessage(
              'Your workspace is out of sync with the latest branch state.',
              { modal: true, detail: 'You must Sync before running tasks. Click Sync to pull the latest branch versions. (You may need to stop the running task manually.)' },
              'Sync',
            );
            if (choice !== 'Sync') return;
            await vscode.commands.executeCommand('versioncon.sync');
          })();
        }),
      );

      // --- FileSystemWatcher for branch tree auto-refresh ---
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceFolder, '.versioncon/branches/**/*'),
      );

      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      const debouncedRefresh = () => {
        if (debounceTimer) { clearTimeout(debounceTimer); }
        debounceTimer = setTimeout(() => {
          branchProvider.refresh();
        }, 50);
      };

      watcher.onDidCreate(debouncedRefresh);
      watcher.onDidChange(debouncedRefresh);
      watcher.onDidDelete(debouncedRefresh);
      context.subscriptions.push(watcher);

      // --- Phase 4.3 SC-5: workspace-wide watcher → WorkspaceDiffer →
      // LocalChangesStatusBar. Distinct from the branchTree watcher above:
      // different root (whole workspace, not .versioncon/branches/), different
      // debounce window (500ms per SC-5 not 50ms), different consumer (status
      // bar, not branch tree). WorkspaceDiffer's exclusion list filters out
      // .versioncon/.vscode/node_modules/etc internally so we do NOT need to
      // narrow the glob here. ---
      const wsWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceFolder, '**/*'),
      );
      let localChangesDebounce: ReturnType<typeof setTimeout> | null = null;
      const recomputeLocalChanges = (): void => {
        if (localChangesDebounce) { clearTimeout(localChangesDebounce); }
        localChangesDebounce = setTimeout(() => {
          void (async () => {
            try {
              // Session-gate (Rule 2 — beyond-plan UX correctness). When there
              // is no active host or client, the "local changes vs. branch"
              // concept is meaningless to the user — there is no peer to push
              // to. Hide the indicator instead of broadcasting a stale count.
              // The diff itself would still be well-defined (branchDir is a
              // local directory), but the UX intent of SC-5 is "show me when
              // I have work to share with my session"; no session = nothing
              // to share.
              if (activeHost === null && activeClient === null) {
                localChangesStatusBar?.hide();
                return;
              }
              const differ = new WorkspaceDiffer();
              const diff = await differ.diff(
                workspaceFolder.uri.fsPath,
                fsLayer.getBranchDir(),
              );
              localChangesStatusBar?.refresh(diff);
            } catch (err) {
              // Diff failure must never break the watcher — log and bail so the
              // next event will try again. Pre-existing pattern from the
              // sync handler and Plan 04.3-02 push auto-stage.
              console.error('[versioncon] LocalChangesStatusBar refresh failed', err);
            }
          })();
        }, 500);
      };
      wsWatcher.onDidCreate(recomputeLocalChanges);
      wsWatcher.onDidChange(recomputeLocalChanges);
      wsWatcher.onDidDelete(recomputeLocalChanges);
      context.subscriptions.push(wsWatcher);
      // One-shot initial refresh so the status bar reflects state at
      // activation — without this the user has to touch a file before the
      // indicator appears, which violates SC-5's "appears within 500ms"
      // intent for the first-render case.
      recomputeLocalChanges();
    })();
  }
}

export async function deactivate(): Promise<void> {
  // D-15: Host shutdown confirmation
  if (activeHost) {
    const members = activeHost.getMembers();
    const memberCount = members.length;
    if (memberCount > 0) {
      await vscode.window.showWarningMessage(
        `You're hosting a session with ${memberCount} member${memberCount > 1 ? 's' : ''}. End session?`,
        { modal: true },
        'End Session',
      );
    }
    activeHost.stop();
  }
  if (activeClient) {
    activeClient.disconnect();
  }
  // Phase 8 (Plan 08-09): release the MCP server port + remove our entries
  // from both .vscode/mcp.json AND .mcp.json so a stale URL pointing at a
  // dead port doesn't haunt the user's mcp.json after the extension shuts
  // down. Best-effort — swallow any error since deactivate MUST NOT throw
  // (VS Code's extension-host shutdown chains other deactivate hooks
  // sequentially; throwing here breaks them). Even if close fails, the GC
  // + process exit free the port.
  if (runningMcpHandle) {
    try {
      await stopMcpLifecycle(runningMcpHandle, {
        removeMcpConfig: async (): Promise<void> => {
          const folder = mcpWorkspaceFolderPath;
          if (!folder) return;
          await removeMcpConfig(folder, '.vscode/mcp.json', 'versioncon');
          await removeMcpConfig(folder, '.mcp.json', 'versioncon');
        },
        log: (): void => {
          /* no OutputChannel after deactivate — channel may already be disposed */
        },
      });
    } catch {
      /* swallow — deactivate must not throw */
    }
    runningMcpHandle = null;
    mcpWorkspaceFolderPath = null;
  }
}
