import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import { WizardPanel } from './ui/WizardPanel.js';
import { JoinPanel } from './ui/JoinPanel.js';
import { SidebarProvider } from './ui/SidebarProvider.js';
import { StatusBarManager } from './ui/StatusBarManager.js';
import { SessionHistory } from './storage/SessionHistory.js';
import { SessionHost } from './host/SessionHost.js';
import { SessionClient } from './client/SessionClient.js';
import type { ConnectionStatus } from './types/session.js';
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
import { createTimestamp } from './network/protocol.js';

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
// Phase 3: module-level references so wireHostEvents can wire late-arriving
// services into a freshly-created SessionHost. Set by the async IIFE after
// permissions/pushHistory are loaded.
let activePermissions: { canPushToBranch: (memberId: string, branchName: string) => boolean } | null = null;
let activePushHistory: { getLatestRecord: () => { id: string } | undefined } | null = null;

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

  // --- Helper: wire host events to UI ---
  function wireHostEvents(host: SessionHost, sessionName: string): void {
    activeHost = host;
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
    statusBarManager.setStatus('connected', sessionName);
    sidebarProvider.updateState({
      connectionStatus: 'connected',
      sessionName,
      role: 'host',
      members: host.getMembers().map((m) => ({
        id: m.id, displayName: m.displayName, role: m.role, isOnline: m.isOnline,
      })),
      bandwidthStats: host.getBandwidthStats(),
    });

    host.on('member-joined', () => {
      sidebarProvider.updateState({
        members: host.getMembers().map((m) => ({
          id: m.id, displayName: m.displayName, role: m.role, isOnline: m.isOnline,
        })),
        bandwidthStats: host.getBandwidthStats(),
      });
    });

    host.on('member-left', () => {
      sidebarProvider.updateState({
        members: host.getMembers().map((m) => ({
          id: m.id, displayName: m.displayName, role: m.role, isOnline: m.isOnline,
        })),
        bandwidthStats: host.getBandwidthStats(),
      });
    });

    host.on('session-ended', () => {
      activeHost = null;
      statusBarManager.setStatus('disconnected');
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
    sidebarProvider.updateState({
      connectionStatus: 'connected',
      sessionName: info?.name ?? null,
      role: 'member',
      members: client.getMembers().map((m) => ({
        id: m.id, displayName: m.displayName, role: m.role, isOnline: m.isOnline,
      })),
      bandwidthStats: null,
    });

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
      sidebarProvider.updateState({
        connectionStatus: data.status,
        error: data.status === 'disconnected' ? (data.error ?? 'Connection lost') : null,
      });
      // D-11: if 'reconnecting', no toast. D-12: no workspace lockout.
      if (data.status === 'disconnected' && data.error) {
        vscode.window.showWarningMessage(`VersionCon: ${data.error}`);
      }
      // PUSH-09: reset sync tracker on disconnect so the next session starts
      // from a clean state. On reconnect, sync-response reseeds latestPushId.
      if (data.status === 'disconnected') {
        syncTracker.reset();
      }
    });

    // Phase 3: Handle push/branch notifications from other members
    client.on('push-received', (data) => {
      // PUSH-09: track remote push -- workspace is now potentially out of sync
      syncTracker.onRemotePush(data.pushId);

      // PUSH-03: surface file overlap to the receiving member so they know
      // immediately which of their tracked files were touched.
      let overlapping: string[] = [];
      let overlapMsg = '';
      if (workspaceProvider) {
        const tracked = workspaceProvider.getTrackedPaths();
        overlapping = data.files
          .filter(f => tracked.includes(f.relativePath))
          .map(f => f.relativePath);
        if (overlapping.length > 0) {
          overlapMsg = ` -- affects your files: ${overlapping.join(', ')}`;
          statusBarManager.setSyncWarning(true);
        }
      }
      void vscode.window.showInformationMessage(
        `${data.memberDisplayName} pushed ${data.files.length} file(s): "${data.message}"${overlapMsg}`,
      );
    });

    client.on('push-reverted', (data) => {
      // PUSH-09: a revert changes branch state -- treat as a remote push so
      // the user is prompted to acknowledge.
      syncTracker.onRemotePush(data.pushId);
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
    });

    client.on('branch-created', (data) => {
      // BRANCH-03: refresh the all-branches view when a remote member creates a branch
      if (activeBranchListProvider) {
        activeBranchListProvider.refresh();
      }
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
  }

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('versioncon.hostSession', () => {
      void WizardPanel.createOrShow(context, (host: SessionHost, sessionName: string) => {
        wireHostEvents(host, sessionName);
      });
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
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.stageForPush', (entry: { relativePath: string }) => {
          workspaceState.stageFile(entry.relativePath);
          workspaceProvider!.stageFile(entry.relativePath);
        }),
      );

      // Unstage a file
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.unstageFile', (entry: { relativePath: string }) => {
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
              activeHost.broadcastPush(record);
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
                activeHost.broadcastRevert(record);
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
                activeHost.broadcastRevert(fullRecord);
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
              activeHost.broadcastBranchCreated(info);
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

      // --- PUSH-09: Mark Synced command ---
      // v1: sync-state-only operation. Clears the SyncTracker out-of-sync
      // flag and refreshes the branch tree so the user sees the latest
      // branch contents in the BranchTreeProvider. Workspace files are NOT
      // modified. Full file pull (copying branch files into the workspace)
      // is deferred to a later phase -- workspace reconciliation semantics
      // need their own design.
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.markSynced', () => {
          branchProvider.refresh();
          syncTracker.onSync();
          statusBarManager.setSyncWarning(false);
          void vscode.window.showInformationMessage(
            'Marked as synced with latest branch state. (Workspace files unchanged -- drag from branch to workspace to pull file contents.)',
          );
        }),
      );

      // --- PUSH-09: Sync-before-run enforcement ---
      // WARNING only, never blocking (per D-12/SAFE-02). When the user starts
      // a debug session or task while out of sync, prompt them to mark as
      // synced or ignore. The warning is informational; the run proceeds
      // regardless of choice.
      context.subscriptions.push(
        vscode.debug.onDidStartDebugSession(() => {
          if (!syncTracker.isInSync()) {
            void vscode.window.showWarningMessage(
              'Your workspace may be out of sync with the latest branch state. Drag from branch to workspace to pull file contents, or mark as synced if you have already reconciled.',
              'Mark Synced',
              'Ignore',
            ).then(choice => {
              if (choice === 'Mark Synced') {
                void vscode.commands.executeCommand('versioncon.markSynced');
              }
            });
          }
        }),
      );

      context.subscriptions.push(
        vscode.tasks.onDidStartTask(() => {
          if (!syncTracker.isInSync()) {
            void vscode.window.showWarningMessage(
              'Your workspace may be out of sync with the latest branch state. Drag from branch to workspace to pull file contents, or mark as synced if you have already reconciled.',
              'Mark Synced',
              'Ignore',
            ).then(choice => {
              if (choice === 'Mark Synced') {
                void vscode.commands.executeCommand('versioncon.markSynced');
              }
            });
          }
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
