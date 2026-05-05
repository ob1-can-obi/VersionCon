// TreeNode matches @vscode-elements/elements tree data structure
export interface TreeNode {
  label: string;
  value: string;                    // relative path used as drag payload
  icons?: {
    branch?: string;                // codicon name for collapsed directory
    open?: string;                  // codicon name for expanded directory
    leaf?: string;                  // codicon name for file
  };
  subItems?: TreeNode[];           // children (directories have these)
}

// Messages from webview to extension host
export interface DragToWorkspacePayload {
  path: string;                    // relative path within branch
  isDirectory: boolean;
}

export interface DragToBranchPayload {
  path: string;                    // relative path within workspace
}

// Staged file metadata
// NOTE: Uses `path` (not `relativePath`) to match Wave 0 test expectations
export interface StagedFile {
  path: string;                    // relative path within workspace
  stagedAt: number;                // Unix timestamp ms
}

// Full state snapshot pushed to webview on mount and after mutations
export interface SplitPaneState {
  workspaceTree: TreeNode[];
  branchTree: TreeNode[];
  stagedFiles: StagedFile[];
}

// Messages the webview can send to extension host
export type WebviewMessage =
  | { type: 'webview-ready' }
  | { type: 'drag-to-workspace'; payload: DragToWorkspacePayload }
  | { type: 'drag-to-branch'; payload: DragToBranchPayload };

// Messages extension host sends to webview
export type HostMessage =
  | { type: 'state-update'; payload: SplitPaneState };
