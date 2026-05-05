// @ts-check
// Split-pane webview script for VersionCon workspace/branch view.
//
// This file runs inside the webview iframe. It:
// 1. Fires 'webview-ready' on mount (stateless pattern)
// 2. Listens for 'state-update' messages from the extension host
// 3. Renders workspace and branch trees using <vscode-tree>
// 4. Handles bidirectional HTML5 drag-and-drop between panes
// 5. Posts drag-to-workspace / drag-to-branch messages to extension host

// Acquire the VS Code API for postMessage communication
// @ts-ignore -- acquireVsCodeApi is injected by the webview host
const vscode = acquireVsCodeApi();

// --- State ---
/** @type {object|null} */
let currentState = null;

/**
 * Tracks what is currently being dragged.
 * @type {{ source: 'workspace'|'branch', path: string, isDirectory: boolean }|null}
 */
let dragState = null;

/**
 * Tracks the selected item in each tree (set by vsc-tree-select events).
 * Since <vscode-tree> renders in shadow DOM, we cannot set draggable on
 * individual items. Instead, we track the selected item and use the
 * pane-content container's dragstart to know WHAT is being dragged.
 * @type {{ workspace: object|null, branch: object|null }}
 */
const selectedItem = { workspace: null, branch: null };

// --- DOM References ---
/** @type {HTMLElement} */
const workspaceTree = /** @type {HTMLElement} */ (document.getElementById('workspace-tree'));
/** @type {HTMLElement} */
const branchTree = /** @type {HTMLElement} */ (document.getElementById('branch-tree'));
/** @type {HTMLElement} */
const workspacePane = /** @type {HTMLElement} */ (document.getElementById('workspace-pane'));
/** @type {HTMLElement} */
const branchPane = /** @type {HTMLElement} */ (document.getElementById('branch-pane'));
/** @type {HTMLElement} */
const workspaceContent = /** @type {HTMLElement} */ (document.getElementById('workspace-content'));
/** @type {HTMLElement} */
const branchContent = /** @type {HTMLElement} */ (document.getElementById('branch-content'));
/** @type {HTMLElement} */
const stagedCount = /** @type {HTMLElement} */ (document.getElementById('staged-count'));

// --- Initialization ---
// Fire webview-ready on mount (stateless pattern: extension host responds with full state)
vscode.postMessage({ type: 'webview-ready' });

// Listen for state updates from extension host
window.addEventListener('message', (event) => {
  const message = event.data;
  if (message && message.type === 'state-update') {
    currentState = message.payload;
    renderState(currentState);
  }
});

// --- State Rendering ---

/**
 * Render the full state snapshot into the DOM.
 * @param {object} state - SplitPaneState from extension host
 * @param {Array} state.workspaceTree - TreeNode[] for workspace
 * @param {Array} state.branchTree - TreeNode[] for branch
 * @param {Array} state.stagedFiles - StagedFile[] for staged count
 */
function renderState(state) {
  // Update workspace tree data
  if (state.workspaceTree && state.workspaceTree.length > 0) {
    // @ts-ignore -- data property is set on the vscode-tree web component
    workspaceTree.data = state.workspaceTree;
    workspaceTree.style.display = '';
    removeEmptyState(workspaceContent);
  } else {
    // @ts-ignore
    workspaceTree.data = [];
    showEmptyState(workspaceContent, 'No files in workspace. Drag files from the branch pane to start working.');
  }

  // Update branch tree data
  if (state.branchTree && state.branchTree.length > 0) {
    // @ts-ignore -- data property is set on the vscode-tree web component
    branchTree.data = state.branchTree;
    branchTree.style.display = '';
    removeEmptyState(branchContent);
  } else {
    // @ts-ignore
    branchTree.data = [];
    showEmptyState(branchContent, 'No files in branch. The branch directory is empty.');
  }

  // Update staged count badge
  const count = state.stagedFiles ? state.stagedFiles.length : 0;
  if (count > 0) {
    stagedCount.textContent = String(count) + ' staged';
  } else {
    stagedCount.textContent = '';
  }
}

/**
 * Show an empty state message in a pane content area.
 * @param {HTMLElement} container
 * @param {string} message
 */
function showEmptyState(container, message) {
  let el = container.querySelector('.empty-state');
  if (!el) {
    el = document.createElement('div');
    el.className = 'empty-state';
    container.appendChild(el);
  }
  el.textContent = message;
}

/**
 * Remove the empty state message from a pane content area.
 * @param {HTMLElement} container
 */
function removeEmptyState(container) {
  const el = container.querySelector('.empty-state');
  if (el) {
    el.remove();
  }
}

// --- Tree Selection Tracking ---
// <vscode-tree> fires 'vsc-tree-select' when an item is clicked.
// We use this to know WHAT the user intends to drag.

workspaceTree.addEventListener('vsc-tree-select', (e) => {
  // @ts-ignore -- detail contains the selected tree item
  selectedItem.workspace = e.detail;
});

branchTree.addEventListener('vsc-tree-select', (e) => {
  // @ts-ignore -- detail contains the selected tree item
  selectedItem.branch = e.detail;
});

// --- Drag Source: Branch Content ---
// When the user starts dragging from the branch pane content area,
// set the drag state based on the currently selected branch item.

branchContent.addEventListener('dragstart', (e) => {
  if (!selectedItem.branch) {
    e.preventDefault();
    return;
  }

  const item = /** @type {any} */ (selectedItem.branch);
  dragState = {
    source: 'branch',
    path: item.value || '',
    isDirectory: !!(item.subItems && item.subItems.length > 0),
  };

  if (e.dataTransfer) {
    e.dataTransfer.setData('text/plain', dragState.path);
    e.dataTransfer.effectAllowed = 'copy';
  }
});

// --- Drag Source: Workspace Content ---
// When the user starts dragging from the workspace pane content area,
// set the drag state based on the currently selected workspace item.

workspaceContent.addEventListener('dragstart', (e) => {
  if (!selectedItem.workspace) {
    e.preventDefault();
    return;
  }

  const item = /** @type {any} */ (selectedItem.workspace);
  dragState = {
    source: 'workspace',
    path: item.value || '',
    isDirectory: !!(item.subItems && item.subItems.length > 0),
  };

  if (e.dataTransfer) {
    e.dataTransfer.setData('text/plain', dragState.path);
    e.dataTransfer.effectAllowed = 'copy';
  }
});

// --- Drop Target: Workspace Pane (receives branch items) ---

workspacePane.addEventListener('dragover', (e) => {
  // Only accept drops from branch pane
  if (dragState && dragState.source === 'branch') {
    e.preventDefault();
    workspacePane.classList.add('drag-over');
  }
});

workspacePane.addEventListener('dragleave', (e) => {
  // Only remove if leaving the pane entirely (not entering a child)
  if (!workspacePane.contains(/** @type {Node} */ (e.relatedTarget))) {
    workspacePane.classList.remove('drag-over');
  }
});

workspacePane.addEventListener('drop', (e) => {
  e.preventDefault();
  workspacePane.classList.remove('drag-over');

  if (dragState && dragState.source === 'branch') {
    vscode.postMessage({
      type: 'drag-to-workspace',
      payload: {
        path: dragState.path,
        isDirectory: dragState.isDirectory,
      },
    });
  }

  dragState = null;
});

// --- Drop Target: Branch Pane (receives workspace items) ---

branchPane.addEventListener('dragover', (e) => {
  // Only accept drops from workspace pane
  if (dragState && dragState.source === 'workspace') {
    e.preventDefault();
    branchPane.classList.add('drag-over');
  }
});

branchPane.addEventListener('dragleave', (e) => {
  // Only remove if leaving the pane entirely (not entering a child)
  if (!branchPane.contains(/** @type {Node} */ (e.relatedTarget))) {
    branchPane.classList.remove('drag-over');
  }
});

branchPane.addEventListener('drop', (e) => {
  e.preventDefault();
  branchPane.classList.remove('drag-over');

  if (dragState && dragState.source === 'workspace') {
    vscode.postMessage({
      type: 'drag-to-branch',
      payload: {
        path: dragState.path,
      },
    });
  }

  dragState = null;
});

// --- Drag End Cleanup ---
// Clean up drag state and visual indicators when drag ends anywhere.

document.addEventListener('dragend', () => {
  dragState = null;
  workspacePane.classList.remove('drag-over');
  branchPane.classList.remove('drag-over');
});
