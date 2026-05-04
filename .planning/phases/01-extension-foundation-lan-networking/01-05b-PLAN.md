---
phase: 01-extension-foundation-lan-networking
plan: 05b
type: execute
wave: 3
depends_on: [01-02, 01-03]
files_modified:
  - src/ui/SidebarProvider.ts
  - src/ui/webview/sidebar/sidebar.html
  - src/ui/webview/sidebar/sidebar.css
  - src/ui/webview/sidebar/sidebar.js
  - src/ui/StatusBarManager.ts
autonomous: true
requirements:
  - NET-05

must_haves:
  truths:
    - "Sidebar panel shows member list with display names and online status per D-16"
    - "Sidebar shows host admin controls: kick and bandwidth monitor per D-13/D-14"
    - "Sidebar shows Host Session and Join Session buttons when disconnected"
    - "Status bar shows connection state icon: green for connected, yellow for reconnecting, red for disconnected per D-09 and D-10"
    - "Status bar is always visible regardless of which tab is active per NET-05"
    - "SidebarProvider exposes onDisconnectRequested and onKickRequested callback methods for Plan 06 wiring"
  artifacts:
    - path: "src/ui/SidebarProvider.ts"
      provides: "WebviewViewProvider for sidebar with member list and session controls"
      exports: ["SidebarProvider"]
    - path: "src/ui/StatusBarManager.ts"
      provides: "Status bar item showing connection state"
      exports: ["StatusBarManager"]
    - path: "src/ui/webview/sidebar/sidebar.html"
      provides: "HTML template for sidebar webview"
      contains: "sidebar-root"
    - path: "src/ui/webview/sidebar/sidebar.css"
      provides: "Sidebar styling with VS Code CSS variables"
      contains: "var(--vscode"
    - path: "src/ui/webview/sidebar/sidebar.js"
      provides: "Sidebar webview script with member list rendering"
      contains: "acquireVsCodeApi"
  key_links:
    - from: "src/ui/SidebarProvider.ts"
      to: "src/types/session.ts"
      via: "renders Member[] from session state"
      pattern: "Member"
    - from: "src/ui/StatusBarManager.ts"
      to: "src/types/session.ts"
      via: "displays ConnectionStatus as icon + text"
      pattern: "ConnectionStatus"
---

<objective>
Build the sidebar panel (member list + session management) and status bar indicator (connection state).

Purpose: The sidebar provides always-accessible session management (D-14) and member visibility (D-16). The status bar provides at-a-glance connection state (D-09, D-10, NET-05).
Output: SidebarProvider and StatusBarManager classes with sidebar webview assets.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/01-extension-foundation-lan-networking/01-CONTEXT.md
@.planning/phases/01-extension-foundation-lan-networking/01-RESEARCH.md

<interfaces>
<!-- From Plan 01 -->
From src/types/session.ts:
```typescript
export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';
export type SessionRole = 'host' | 'member';
export interface Member { id: string; displayName: string; role: SessionRole; isOnline: boolean; joinedAt: number; }
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Implement StatusBarManager with connection state icons and colors</name>
  <files>
    src/ui/StatusBarManager.ts
  </files>
  <read_first>
    src/types/session.ts (ConnectionStatus)
    .planning/phases/01-extension-foundation-lan-networking/01-CONTEXT.md (D-09 status in two places, D-10 three states with colors)
    .planning/phases/01-extension-foundation-lan-networking/01-RESEARCH.md (Status Bar Item Management code example, StatusBarAlignment, ThemeColor)
  </read_first>
  <action>
    Create `src/ui/StatusBarManager.ts`:

    - Import `vscode` and `ConnectionStatus` from types/session
    - Export class `StatusBarManager` implements `vscode.Disposable`:
      - Private `item: vscode.StatusBarItem`
      - Constructor:
        - `this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)`
        - Call `this.setStatus('disconnected')`
        - `this.item.show()`
      - Method `setStatus(status: ConnectionStatus, sessionName?: string): void`:
        - `connected`:
          - `this.item.text = '$(circle-filled) VersionCon'`
          - `this.item.color = new vscode.ThemeColor('testing.iconPassed')` (green)
          - `this.item.tooltip = sessionName ? \`Connected to \${sessionName}\` : 'Connected to session'`
        - `reconnecting`:
          - `this.item.text = '$(sync~spin) VersionCon'`
          - `this.item.color = new vscode.ThemeColor('editorWarning.foreground')` (yellow)
          - `this.item.tooltip = 'Reconnecting...'`
        - `disconnected`:
          - `this.item.text = '$(circle-outline) VersionCon'`
          - `this.item.color = new vscode.ThemeColor('testing.iconFailed')` (red per D-10)
          - `this.item.tooltip = 'Not connected'`
        - Always: `this.item.command = 'versioncon.showSidebar'`
      - Method `dispose(): void`: `this.item.dispose()`
  </action>
  <verify>
    <automated>npm run lint && npm run build && echo "STATUS BAR OK"</automated>
  </verify>
  <acceptance_criteria>
    - src/ui/StatusBarManager.ts contains `export class StatusBarManager`
    - src/ui/StatusBarManager.ts contains `StatusBarAlignment.Left`
    - src/ui/StatusBarManager.ts contains `$(circle-filled)` (connected icon)
    - src/ui/StatusBarManager.ts contains `$(sync~spin)` (reconnecting icon)
    - src/ui/StatusBarManager.ts contains `$(circle-outline)` (disconnected icon)
    - src/ui/StatusBarManager.ts contains `testing.iconPassed` (green ThemeColor)
    - src/ui/StatusBarManager.ts contains `editorWarning.foreground` (yellow ThemeColor)
    - src/ui/StatusBarManager.ts contains `testing.iconFailed` (red ThemeColor per D-10)
    - src/ui/StatusBarManager.ts contains `versioncon.showSidebar` (click command)
    - `npm run lint` exits 0
  </acceptance_criteria>
  <done>Status bar shows connection state with correct icons and colors: green for connected, yellow/spinning for reconnecting, red for disconnected per D-10.</done>
</task>

<task type="auto">
  <name>Task 2: Implement SidebarProvider with member list, session controls, and callback methods</name>
  <files>
    src/ui/SidebarProvider.ts,
    src/ui/webview/sidebar/sidebar.html,
    src/ui/webview/sidebar/sidebar.css,
    src/ui/webview/sidebar/sidebar.js
  </files>
  <read_first>
    src/ui/WizardPanel.ts (follow webview patterns)
    src/types/session.ts (Member, ConnectionStatus)
    .planning/phases/01-extension-foundation-lan-networking/01-CONTEXT.md (D-09 status in two places, D-10 three states with colors, D-13 admin surface member list + kick + bandwidth, D-14 sidebar panel, D-16 basic member list for all)
    .planning/phases/01-extension-foundation-lan-networking/01-RESEARCH.md (Status Bar Item Management code example, StatusBarAlignment, ThemeColor)
  </read_first>
  <action>
    1. Create `src/ui/SidebarProvider.ts`:
       - Import `vscode` and session types
       - Export class `SidebarProvider` implements `vscode.WebviewViewProvider`:
         - Private `view: vscode.WebviewView | undefined`
         - Private `extensionUri: vscode.Uri`
         - Private `context: vscode.ExtensionContext`
         - Private `disconnectHandler: (() => void) | null = null`
         - Private `kickHandler: ((memberId: string) => void) | null = null`
         - SidebarState interface:
           ```typescript
           interface SidebarState {
             connectionStatus: ConnectionStatus;
             sessionName: string | null;
             role: SessionRole | null; // 'host' or 'member'
             members: Array<{ id: string; displayName: string; role: string; isOnline: boolean }>;
             bandwidthStats: Array<{ memberId: string; rateOutKBps: number; rateInKBps: number }> | null; // host-only
             error: string | null;
           }
           ```
         - Private `state: SidebarState` initialized with disconnected defaults
         - Method `resolveWebviewView(webviewView: vscode.WebviewView, ...): void`:
           - Store view reference
           - Set options: `enableScripts: true`, `localResourceRoots: [joinPath(extensionUri, 'src', 'ui', 'webview', 'sidebar')]`
           - Set HTML via template (same nonce CSP pattern)
           - Register message listener:
             - `webview-ready`: send full state
             - `kick-member`: call `this.kickHandler(msg.payload.memberId)` if kickHandler set and role is host
             - `host-session`: fire `vscode.commands.executeCommand('versioncon.hostSession')`
             - `join-session`: fire `vscode.commands.executeCommand('versioncon.joinSession')`
             - `disconnect`: call `this.disconnectHandler()` if disconnectHandler set
         - Method `updateState(partial: Partial<SidebarState>): void`:
           - Merge partial into state
           - If view exists, postMessage state-update
         - Method `onDisconnectRequested(handler: () => void): void`:
           - Store the handler callback for when sidebar sends `disconnect` message
         - Method `onKickRequested(handler: (memberId: string) => void): void`:
           - Store the handler callback for when sidebar sends `kick-member` message
         - Dispose cleanup

    2. Create `src/ui/webview/sidebar/sidebar.css`:
       - VS Code CSS variables for theme matching
       - Compact layout for sidebar width (~300px typical)
       - Session info header: session name, connection status badge (colored dot + text)
       - Button row: "Host Session" and "Join Session" buttons (shown when disconnected)
       - Member list: vertical list with avatar placeholder (first letter circle), display name, online status dot (green = online), role badge ("Host" / "Member")
       - Host-only controls: "Kick" button per member (only shown for host role)
       - Bandwidth section (host-only): simple table showing per-member KB/s rates
       - Disconnect button (shown when connected)

    3. Create `src/ui/webview/sidebar/sidebar.js`:
       - IIFE, acquireVsCodeApi, webview-ready on mount
       - Render from state:
         - **Disconnected state:**
           - "VersionCon" header
           - "Not connected" status
           - Two action buttons: "Host Session" (fires `host-session`), "Join Session" (fires `join-session`)
         - **Connected state:**
           - Session name as header
           - Connection status badge (green dot + "Connected", yellow dot + "Reconnecting")
           - "Members" section header with count
           - For each member: avatar circle (first letter of displayName), displayName, role badge, online dot
           - If role is host: "Kick" button on each non-host member row, clicking fires `{ type: 'kick-member', payload: { memberId } }`
           - If role is host and bandwidthStats available: "Bandwidth" section showing per-member rates as "IN: X KB/s | OUT: Y KB/s"
           - "Disconnect" button at bottom (fires `disconnect` message)

    4. Create `src/ui/webview/sidebar/sidebar.html`:
       - Same template pattern with %%CSP%%, %%NONCE%%, etc.
  </action>
  <verify>
    <automated>npm run lint && npm run build && test -f src/ui/webview/sidebar/sidebar.html && test -f src/ui/StatusBarManager.ts && echo "SIDEBAR OK"</automated>
  </verify>
  <acceptance_criteria>
    - src/ui/SidebarProvider.ts contains `export class SidebarProvider`
    - src/ui/SidebarProvider.ts contains `resolveWebviewView`
    - src/ui/SidebarProvider.ts contains `webview-ready`
    - src/ui/SidebarProvider.ts contains `kick-member` message handler
    - src/ui/SidebarProvider.ts contains `updateState`
    - src/ui/SidebarProvider.ts contains `onDisconnectRequested`
    - src/ui/SidebarProvider.ts contains `onKickRequested`
    - src/ui/webview/sidebar/sidebar.js contains `acquireVsCodeApi()`
    - src/ui/webview/sidebar/sidebar.js contains `host-session` and `join-session` (action buttons)
    - src/ui/webview/sidebar/sidebar.css contains `var(--vscode-`
    - `npm run lint` exits 0
    - `npm run build` exits 0
  </acceptance_criteria>
  <done>Sidebar shows member list per D-16 with host admin controls (kick, bandwidth) per D-13/D-14. SidebarProvider exposes onDisconnectRequested and onKickRequested callback methods ready for Plan 06 wiring. Both use stateless webview pattern.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Sidebar webview -> Extension Host | Sidebar postMessage actions (kick, disconnect) must verify role authorization |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-01-17 | Elevation of Privilege | Sidebar kick-member | mitigate | SidebarProvider checks `role === 'host'` before forwarding kick request; member-role users cannot trigger admin actions |
| T-01-18b | Tampering | Webview CSP | mitigate | Nonce-based CSP on sidebar webview; `default-src 'none'` prevents script injection |
</threat_model>

<verification>
- `npm run lint` passes
- `npm run build` succeeds
- StatusBarManager displays correct icon/color for each of 3 states (green/yellow/red per D-10)
- SidebarProvider shows member list with online status
- SidebarProvider restricts kick to host role
- SidebarProvider exposes onDisconnectRequested and onKickRequested callbacks
- All webviews use nonce-based CSP
</verification>

<success_criteria>
- Status bar always shows connection state (NET-05, D-09, D-10) with red for disconnected
- Sidebar shows member list visible to all (D-16)
- Sidebar has host admin controls: kick and bandwidth monitor (D-13, D-14)
- SidebarProvider callback methods are ready for Plan 06 integration
</success_criteria>

<output>
After completion, create `.planning/phases/01-extension-foundation-lan-networking/01-05b-SUMMARY.md`
</output>
