---
phase: 02-split-pane-ui-file-system-layer
plan: 02
subsystem: split-pane-ui
tags: [webview, split-pane, drag-drop, vscode-tree, UI]
dependency_graph:
  requires: [02-01]
  provides: [SplitPanePanel, splitpane-webview-assets]
  affects: [extension.ts, plan-03-filewatcher]
tech_stack:
  added: []
  patterns: [stateless-webview, single-webview-split, html5-dnd-postmessage]
key_files:
  created:
    - src/ui/SplitPanePanel.ts
    - src/ui/webview/splitpane/splitpane.html
    - src/ui/webview/splitpane/splitpane.css
    - src/ui/webview/splitpane/splitpane.js
  modified: []
decisions:
  - "Used pane-content container with draggable=true and vsc-tree-select for drag source tracking (shadow DOM prevents direct tree item draggable attributes)"
  - "Added font-src to CSP to allow codicon fonts used by vscode-tree component"
  - "Added localResourceRoots for both splitpane dir and vscode-elements dist dir"
  - "Used relatedTarget check in dragleave to prevent flicker when entering child elements"
metrics:
  duration: "4m"
  completed: "2026-05-05T16:59:28Z"
  tasks_completed: 2
  tasks_total: 2
  files_created: 4
  files_modified: 0
  total_lines: 815
---

# Phase 02 Plan 02: Split-Pane WebviewPanel + Webview Assets Summary

Single-webview split-pane panel with bidirectional drag-and-drop between workspace and branch trees using vscode-tree components, stateless webview pattern, and strict CSP nonce security.

## Task Results

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create SplitPanePanel.ts with stateless webview pattern | 13b3118 | src/ui/SplitPanePanel.ts |
| 2 | Create webview assets (HTML template, CSS layout, JS drag handlers) | ea393b9 | src/ui/webview/splitpane/splitpane.html, splitpane.css, splitpane.js |

## What Was Built

### SplitPanePanel.ts (Extension Host Side)
- Singleton WebviewPanel class with `createOrShow` static method
- Creates `.versioncon/branch/` directory on first use
- Instantiates FileSystemLayer, BranchState, and WorkspaceState from Plan 01 types
- Handles three webview messages: `webview-ready`, `drag-to-workspace`, `drag-to-branch`
- Message validation checks type string and payload shape before processing (T-02-05)
- Strict CSP with crypto nonce: `default-src 'none'; style-src; script-src 'nonce-{n}'; font-src` (T-02-06)
- Template replacement pattern matches WizardPanel.ts exactly (%%CSP%%, %%NONCE%%, %%CSS_URI%%, %%JS_URI%%, %%ELEMENTS_URI%%)
- Public `onExternalChange()` method for Plan 03 FileSystemWatcher integration
- localResourceRoots includes both splitpane directory and @vscode-elements/elements dist

### splitpane.html (Webview Template)
- Two `<vscode-tree>` instances in a flex split container
- Workspace pane (left) with staged count badge
- Branch pane (right) with "read-only" badge
- Both pane content areas have `draggable="true"` for DnD source
- Loads @vscode-elements bundled.js and splitpane.js with nonce attributes

### splitpane.css (Layout Styles)
- Flexbox split layout: `.split-container` with two `.pane` children
- 4px divider with `col-resize` cursor (prepared for future resize)
- VS Code theme variables only (no hardcoded colors)
- Drag-over visual feedback: dashed outline + highlighted header
- Section headers with uppercase labels matching VS Code sidebar style
- Empty state styling for when trees have no data

### splitpane.js (Webview Logic)
- Fires `webview-ready` immediately on load (stateless pattern)
- Listens for `state-update` messages and renders both trees
- Tree selection tracking via `vsc-tree-select` events (workaround for shadow DOM)
- Branch content dragstart sets drag state with path and isDirectory
- Workspace pane drop target posts `drag-to-workspace` message
- Workspace content dragstart sets drag state for reverse direction
- Branch pane drop target posts `drag-to-branch` message
- Dragleave uses `relatedTarget` check to avoid flicker
- Dragend cleanup clears all drag state and visual indicators
- Empty state messages when trees have no data
- Staged file count badge updates on every state render

## Requirements Coverage

| Req ID | Description | Status |
|--------|-------------|--------|
| UI-01 | Split panes - left workspace, right branch | Covered - CSS flexbox split with two panes |
| UI-02 | Branch tree with expandable directories | Covered - vscode-tree with TreeNode data |
| UI-03 | Workspace tree reflects filesystem | Covered - vscode-tree with refreshAndPushState |
| UI-07 | Drag workspace-to-branch stages files | Covered - drag-to-branch postMessage |
| UI-09 | Single webview avoids cross-webview regression | Covered - single WebviewPanel with CSS split |

## Deviations from Plan

None - plan executed exactly as written.

## Decisions Made

1. **Drag source via container draggable**: Since `<vscode-tree>` renders in shadow DOM, individual tree items cannot have `draggable` set directly. Used `draggable="true"` on `.pane-content` containers combined with `vsc-tree-select` event tracking to determine what is being dragged.

2. **Font-src in CSP**: Added `font-src ${webview.cspSource}` to the Content Security Policy to allow the codicon font files required by the vscode-tree component to render file/folder icons.

3. **Dual localResourceRoots**: Added both the splitpane webview directory and the @vscode-elements/elements dist directory to `localResourceRoots` so the webview can load both custom assets and the elements bundle.

4. **Dragleave flicker prevention**: Used `relatedTarget` contains check in dragleave handlers to prevent the drag-over class from being removed when hovering over child elements within the pane.

## Self-Check: PASSED

- [x] src/ui/SplitPanePanel.ts exists (400 lines)
- [x] src/ui/webview/splitpane/splitpane.html exists (35 lines)
- [x] src/ui/webview/splitpane/splitpane.css exists (114 lines)
- [x] src/ui/webview/splitpane/splitpane.js exists (266 lines)
- [x] Commit 13b3118 exists
- [x] Commit ea393b9 exists
- [x] TypeScript compiles without errors
- [x] HTML contains 2 vscode-tree elements
- [x] CSS uses only VS Code theme variables
- [x] JS sends webview-ready and handles state-update
- [x] JS implements bidirectional drag-and-drop
