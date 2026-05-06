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
import { WorkspaceTreeProvider } from './ui/WorkspaceTreeProvider.js';
import { WorkspaceState } from './filesystem/WorkspaceState.js';
import { BranchManager } from './filesystem/BranchManager.js';
import { BranchPermissions } from './filesystem/BranchPermissions.js';
import { PushHistory } from './filesystem/PushHistory.js';
import { PushService } from './filesystem/PushService.js';

// Module-level state for deactivation access
let activeHost: SessionHost | null = null;
let activeClient: SessionClient | null = null;
let sidebarProvider: SidebarProvider;
let statusBarManager: StatusBarManager;

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
    });

    // Phase 3: Handle push/branch notifications from other members
    client.on('push-received', (data) => {
      void vscode.window.showInformationMessage(
        `${data.memberDisplayName} pushed ${data.files.length} file(s): "${data.message}"`,
      );
      // Check sync overlap with workspace
      if (workspaceProvider) {
        const tracked = workspaceProvider.getTrackedPaths();
        const overlap = data.files.some(f => tracked.includes(f.relativePath));
        if (overlap) {
          statusBarManager.setSyncWarning(true);
        }
      }
    });

    client.on('push-reverted', (data) => {
      void vscode.window.showInformationMessage(
        `${data.memberDisplayName} reverted a push on branch "${data.branch}"`,
      );
    });

    client.on('branch-created', (data) => {
      void vscode.window.showInformationMessage(
        `New branch created: "${data.branch.name}"`,
      );
    });

    client.on('branch-locked', (data) => {
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

      const branchProvider = new BranchTreeProvider(fsLayer);
      branchProvider.setBranchDir(activeBranchDir);
      branchProvider.setActiveBranchName(activeBranchName);

      workspaceProvider = new WorkspaceTreeProvider(fsLayer);

      // Register tree data providers
      context.subscriptions.push(
        vscode.window.registerTreeDataProvider('versioncon.branchTree', branchProvider),
        vscode.window.registerTreeDataProvider('versioncon.workspaceTree', workspaceProvider),
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
          const summary = await pushService.generateSummary(stagedPaths);

          // Show summary and ask for commit message
          const detail = summary.files.map(f =>
            `${f.status === 'added' ? '+' : f.status === 'deleted' ? '-' : '~'} ${f.relativePath} (+${f.addedLines} -${f.removedLines})`
          ).join('\n');

          const message = await vscode.window.showInputBox({
            prompt: `Push ${staged.length} file(s) (+${summary.totalAdded} -${summary.totalRemoved} lines)`,
            placeHolder: 'Enter push message...',
            validateInput: (v) => v.trim() ? null : 'Message is required',
          });

          if (!message) return;

          try {
            const record = await pushService.executePush(message, stagedPaths, {
              id: currentMemberId,
              displayName: currentDisplayName,
            });

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
          const name = await vscode.window.showInputBox({
            prompt: 'Enter new branch name',
            placeHolder: 'feature-xyz',
            validateInput: (v) => /^[a-zA-Z0-9_-]+$/.test(v) ? null : 'Alphanumeric, hyphens, and underscores only',
          });
          if (!name) return;

          try {
            const activeBranch = await branchManager.getActiveBranch();
            const info = await branchManager.createBranch(name, activeBranch, currentMemberId);
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

      // Manage branch permissions (host-only)
      context.subscriptions.push(
        vscode.commands.registerCommand('versioncon.manageBranchPermissions', async () => {
          const action = await vscode.window.showQuickPick([
            { label: 'Set merge policy', description: 'Who can merge to main' },
            { label: 'Lock a branch', description: 'Restrict push access' },
            { label: 'Unlock a branch', description: 'Remove push restrictions' },
          ], { placeHolder: 'Branch permission management' });

          if (!action) return;

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
              void vscode.window.showInformationMessage(`Branch "${selected.label}" unlocked.`);

              if (activeHost) {
                activeHost.broadcastBranchLocked(selected.label, false);
              }
            }
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
