import * as assert from 'assert';
import * as vscode from 'vscode';
import { ChatPanel, type ChatPanelRefs } from '../../ui/ChatPanel.js';

/**
 * Phase 4 chat panel lifecycle (Plan 04-14, CR-04).
 *
 * Verifies the refactor that replaced the public
 * `ChatPanel.onDidChangeViewState(handler)` setter with
 * `ChatPanelRefs.onPanelActivated`. The new path binds the unread-clear
 * callback to the panel's own `onDidChangeViewState` Disposable (already
 * pushed to `this.disposables`), so it auto-disposes when the panel
 * disposes — no orphan handler can outlive the panel.
 *
 * Strategy: tests construct `ChatPanel` directly via its private constructor
 * (cast through `unknown`) with a fake `WebviewPanel`. The fake exposes a
 * controllable `EventEmitter<WebviewPanelOnDidChangeViewStateEvent>` so the
 * suite can fire view-state changes deterministically without driving the
 * VS Code window focus model. This is the same shape the existing chat
 * tests use to keep dispatch logic unit-testable without a real webview.
 */

interface FakeWebviewPanel {
  active: boolean;
  visible: boolean;
  webview: {
    html: string;
    cspSource: string;
    asWebviewUri: (u: vscode.Uri) => vscode.Uri;
    postMessage: (m: unknown) => Thenable<boolean>;
    onDidReceiveMessage: vscode.Event<unknown>;
  };
  dispose: () => void;
  reveal: () => void;
  onDidDispose: vscode.Event<void>;
  onDidChangeViewState: vscode.Event<vscode.WebviewPanelOnDidChangeViewStateEvent>;
  // Test-only handles to drive the panel's lifecycle synchronously.
  __fireViewState: (active: boolean) => void;
  __fireDispose: () => void;
  __disposed: boolean;
}

function makeFakePanel(): FakeWebviewPanel {
  const viewStateEmitter = new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
  const disposeEmitter = new vscode.EventEmitter<void>();
  const messageEmitter = new vscode.EventEmitter<unknown>();
  let active = false;
  let disposed = false;
  const fake: FakeWebviewPanel = {
    get active() { return active; },
    set active(v: boolean) { active = v; },
    visible: true,
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (u: vscode.Uri) => u,
      postMessage: () => Promise.resolve(true),
      onDidReceiveMessage: messageEmitter.event,
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeEmitter.fire();
    },
    reveal() { /* no-op */ },
    onDidDispose: disposeEmitter.event,
    onDidChangeViewState: viewStateEmitter.event,
    __fireViewState(activeFlag: boolean) {
      active = activeFlag;
      viewStateEmitter.fire({ webviewPanel: fake as unknown as vscode.WebviewPanel });
    },
    __fireDispose() {
      fake.dispose();
    },
    get __disposed() { return disposed; },
  };
  return fake;
}

function makeMockContext(): vscode.ExtensionContext {
  return {
    extensionUri: vscode.Uri.file('/tmp/versioncon-fake'),
    extensionPath: '/tmp/versioncon-fake',
    subscriptions: [],
    workspaceState: { get: () => undefined, update: () => Promise.resolve(), keys: () => [] },
    globalState: {
      get: () => undefined,
      update: () => Promise.resolve(),
      keys: () => [],
      setKeysForSync: () => undefined,
    },
    secrets: {
      get: () => Promise.resolve(undefined),
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event,
    },
  } as unknown as vscode.ExtensionContext;
}

function makeRefs(spy: { calls: boolean[] }): ChatPanelRefs {
  return {
    selfId: 'self',
    selfDisplayName: 'Self',
    branch: 'main',
    memberCount: 1,
    getRecords: () => [],
    getChatHiddenBefore: () => null,
    sendChatMessage: () => { /* noop */ },
    openManageChat: () => { /* noop */ },
    getConnectionStatus: () => 'connected',
    onPanelActivated: (active) => spy.calls.push(active),
  };
}

/**
 * Construct a ChatPanel via its private constructor. The static
 * createOrShow factory always builds a real WebviewPanel via
 * vscode.window.createWebviewPanel, which we want to avoid here so we can
 * drive the view-state event synchronously.
 */
function buildChatPanel(
  fakePanel: FakeWebviewPanel,
  refs: ChatPanelRefs,
): ChatPanel {
  const Ctor = ChatPanel as unknown as new (
    panel: unknown,
    context: unknown,
    refs: ChatPanelRefs,
  ) => ChatPanel;
  const instance = new Ctor(fakePanel, makeMockContext(), refs);
  // Mirror createOrShow's "currentPanel" assignment so dispose() and the
  // public setter assertion in test 4 reach the same instance the rest of
  // the suite expects.
  (ChatPanel as unknown as { currentPanel: ChatPanel | undefined }).currentPanel = instance;
  return instance;
}

suite('Phase 4 chat panel lifecycle (Plan 04-14, CR-04)', () => {
  teardown(() => {
    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel.dispose();
    }
  });

  test('refs.onPanelActivated is invoked with true when view state becomes active (CR-04)', () => {
    const spy = { calls: [] as boolean[] };
    const fakePanel = makeFakePanel();
    buildChatPanel(fakePanel, makeRefs(spy));

    fakePanel.__fireViewState(true);

    assert.deepStrictEqual(spy.calls, [true]);
  });

  test('refs.onPanelActivated is invoked with false when view state becomes inactive (CR-04)', () => {
    const spy = { calls: [] as boolean[] };
    const fakePanel = makeFakePanel();
    buildChatPanel(fakePanel, makeRefs(spy));

    fakePanel.__fireViewState(true);
    fakePanel.__fireViewState(false);

    // Both transitions reach the callback so the chatPanelIsActive flag at
    // extension.ts:65 stays in sync with the panel's actual visibility.
    assert.deepStrictEqual(spy.calls, [true, false], 'no callback after dispose');
  });

  test('ChatPanel.dispose disposes the inner onDidChangeViewState Disposable — no further callback (CR-04)', () => {
    const spy = { calls: [] as boolean[] };
    const fakePanel = makeFakePanel();
    const panel = buildChatPanel(fakePanel, makeRefs(spy));

    fakePanel.__fireViewState(true);
    assert.deepStrictEqual(spy.calls, [true]);

    panel.dispose();

    // After dispose, firing the event should NOT invoke the callback again.
    // The inner Disposable was pushed to this.disposables and has been
    // disposed by ChatPanel.dispose(); refs.onPanelActivated is no longer
    // reachable from the event handler.
    fakePanel.__fireViewState(false);
    assert.deepStrictEqual(spy.calls, [true], 'no callback after dispose');
  });

  test('ChatPanel no longer exposes a public onDidChangeViewState setter (CR-04, Plan 04-14)', () => {
    const spy = { calls: [] as boolean[] };
    const fakePanel = makeFakePanel();
    const panel = buildChatPanel(fakePanel, makeRefs(spy));

    assert.strictEqual(
      typeof (panel as unknown as { onDidChangeViewState?: unknown }).onDidChangeViewState,
      'undefined',
      'setter removed in Plan 04-14',
    );
    // The static class itself also must not surface the setter via prototype.
    assert.strictEqual(
      typeof (ChatPanel.prototype as unknown as { onDidChangeViewState?: unknown }).onDidChangeViewState,
      'undefined',
      'setter removed in Plan 04-14 (prototype check)',
    );
  });
});
