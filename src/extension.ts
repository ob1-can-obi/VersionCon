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
import { createTimestamp } from './network/protocol.js';
import { ActivityLogProvider } from './ui/ActivityLogProvider.js';
import { PresenceTreeProvider } from './ui/PresenceTreeProvider.js';
import { computeFileOverlap, getOpenTabPaths } from './utils/fileOverlap.js';
import type { PresenceInfo } from './types/chat.js';
import type { ChatRecord } from './types/chat.js';

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
let activePushHistory: { getLatestRecord: () => { id: string } | undefined } | null = null;

// Phase 4: provider singletons constructed once in activate() so wire helpers
// (which run after the workspace IIFE) and outer-scope event handlers can both
// reach them.
let presenceTreeProvider: PresenceTreeProvider | null = null;
let activityLogProvider: ActivityLogProvider | null = null;
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

/**
 * Format the CONF-07 toast string per UI-SPEC §6.1 (locked literals):
 *   - 1 file overlap: `{name} pushed 1 file — affects: {fileBasename}: '{msg}'`
 *   - 2-3 overlap:    `{name} pushed N file(s) — affects: a, b, c: '{msg}'`
 *   - >3 overlap:     `{name} pushed N file(s) — affects: a, b, +(N-2) more: '{msg}'`
 *   - empty msg → trailing `: '{msg}'` is omitted entirely.
 *
 * Pure helper — exported only for unit-testability shape (no external import yet).
 */
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

    // Phase 4 UAT fix (999.3): when a member leaves, drop their presence row
    // from the host's panel (the broadcast-out to other clients is already
    // handled by SessionHost's member-left broadcast path, but the host's own
    // tree needs explicit cleanup).
    host.on('member-left', (data: { memberId: string }) => {
      presenceTreeProvider?.removeMember(data.memberId);
      updatePresenceContext();
    });

    host.on('session-ended', () => {
      activeHost = null;
      // Plan 04.1-03: drop the pre-allocated HostIdentity reference so the
      // hostAuthSecret is not retained beyond the live session.
      activeHostIdentity = null;
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
      if (activeHost) {
        activeHost.setPermissions(permissions);
        activeHost.setPushHistory(pushHistory);
      }

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
          if (staged.length === 0) {
            void vscode.window.showWarningMessage('No files staged for push. Stage files first.');
            return;
          }

          const stagedPaths = staged.map(s => s.path);

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
            `Push ${staged.length} file(s) (+${summary.totalAdded} -${summary.totalRemoved} lines)`,
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
            const record = await pushService.executePush(message, stagedPaths, {
              id: currentMemberId,
              displayName: currentDisplayName,
            });

            // PUSH-09: mark the local push in the sync tracker (the local
            // user is by definition synced after their own push).
            syncTracker.onLocalPush(record.id);

            // Clear staged state
            workspaceState.clearStaged();
            workspaceProvider!.clearStaged();
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
              const systemRecord = activeHost.broadcastPush(record);
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
}
