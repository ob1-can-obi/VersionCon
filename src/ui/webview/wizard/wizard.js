(function () {
  const vscode = acquireVsCodeApi();
  let currentState = null;

  // -------------------------------------------------------------------------
  // Plan 07-05 — pure helpers exposed for unit-testing.
  //
  // These three functions are the load-bearing logic for the wizard's
  // cloud-mode branch. They are pure (no DOM, no postMessage) so the test
  // suite at src/test/suite/wizardCloudStep.test.ts can pin their behavior
  // against an exact truth table (and the test file embeds duplicates of the
  // same bodies for direct unit-test exercise since wizard.js is webview-only
  // and cannot be loaded from Node).
  // -------------------------------------------------------------------------

  function validateRelayUrl(url) {
    if (typeof url !== 'string' || !url.startsWith('wss://')) return false;
    try { new URL(url); return true; } catch { return false; }
  }

  function buildDeepLink(relayUrl, sessionId, inviteCode, bootstrapToken) {
    const base = 'vscode://versioncon.versioncon/join?relay=' +
      encodeURIComponent(relayUrl) +
      '&session=' + sessionId +
      '&code=' + inviteCode;
    // Phase 7 gap-closure plan 07-13 (MD-03 Option A): append the bootstrap
    // JWT as &bt= when non-empty. When omitted or empty (LAN mode + legacy
    // 3-arg callers), the deep-link is byte-identical to today's output
    // (LAN regression contract — pinned by wizardDeepLinkBootstrap.test.ts
    // test 4). encodeURIComponent escapes the +, /, = chars that base64url
    // JWTs may carry so the joiner-side parser (07-14) reads bt= correctly.
    if (bootstrapToken && bootstrapToken.length > 0) {
      return base + '&bt=' + encodeURIComponent(bootstrapToken);
    }
    return base;
  }

  async function runTestConnection(relayUrl, fetchImpl) {
    const fetcher = fetchImpl || globalThis.fetch;
    try {
      const url = relayUrl.replace('wss://', 'https://') + '/healthz';
      const res = await fetcher(url);
      if (!res || !res.ok) return { ok: false, message: '✗ Cannot reach relay' };
      const body = await res.json();
      if (body && body.ok === true) {
        return { ok: true, sessions: body.sessions, message: '✓ Relay reachable' };
      }
      return { ok: false, message: '✗ Cannot reach relay' };
    } catch {
      return { ok: false, message: '✗ Cannot reach relay' };
    }
  }

  // Side-channel exposure for test / debugging access (NOT a public API).
  globalThis.__versionConWizardHelpers = {
    validateRelayUrl,
    buildDeepLink,
    runTestConnection,
  };

  // Stateless webview pattern: fire webview-ready immediately on mount
  vscode.postMessage({ type: 'webview-ready' });

  window.addEventListener('message', (event) => {
    const { type, payload } = event.data;
    if (type === 'state-update') {
      currentState = payload;
      render(payload);
    }
  });

  function render(state) {
    const root = document.getElementById('wizard-root');
    if (!root) return;

    let html = '<div class="wizard-container">';

    // Error banner
    if (state.error) {
      html += `<div class="error-banner">${escapeHtml(state.error)}</div>`;
    }

    // Step indicator (steps 1-4 only, not on share screen). Plan 07-05 keeps
    // the existing 3-dot rendering for backward-compat with the LAN flow;
    // step 2 (mode-select) is rendered as the "midpoint" without disturbing
    // the count. UI-SPEC mockup suggests 4 dots; we keep 3 as the simplest
    // implementation since the mode-select reads as a logical 1.5 to users.
    if (state.step <= 4) {
      html += renderStepIndicator(state.step);
    }

    // Render current step
    switch (state.step) {
      case 1:
        html += renderStep1(state);
        break;
      case 2:
        html += renderStepModeSelect(state);
        break;
      case 3:
        html += state.mode === 'cloud'
          ? renderStepNetworkCloud(state)
          : renderStep2(state);
        break;
      case 4:
        html += renderStep3(state);
        break;
      case 5:
        html += state.mode === 'cloud'
          ? renderShareScreenCloud(state)
          : renderShareScreen(state);
        break;
    }

    html += '</div>';
    root.innerHTML = html;

    // Attach event listeners after render
    attachListeners(state);
  }

  function renderStepIndicator(activeStep) {
    // Map the 4-step internal machine (1=identity, 2=mode-select, 3=network,
    // 4=invite-code reveal) onto the existing 3-dot visual. Mode-select
    // shares dot 1 with identity; this keeps the LAN flow indicator
    // unchanged from Phase 4.1.
    const visualStep = activeStep >= 3 ? activeStep - 1 : 1;
    let html = '<div class="step-indicator">';
    for (let i = 1; i <= 3; i++) {
      const cls = i < visualStep ? 'completed' : i === visualStep ? 'active' : '';
      html += `<div class="step-dot ${cls}">${i}</div>`;
      if (i < 3) {
        const lineCls = i < visualStep ? 'completed' : '';
        html += `<div class="step-line ${lineCls}"></div>`;
      }
    }
    html += '</div>';
    return html;
  }

  function renderStep1(state) {
    // Plan 04.1-03 (Defect A closure): step 1 collects sessionName + displayName.
    // Both are upfront-identity concerns; the Next button is disabled until
    // BOTH are non-empty after trim.
    const nameOk = !!(state.sessionName && state.sessionName.trim());
    const dispOk = !!(state.displayName && state.displayName.trim());
    const nextDisabled = !nameOk || !dispOk;
    // Plan 04.1 UAT Test 3 fix: maxlength on #display-name raised from 64 to 256 so the >64 validation
    // in WizardPanel.handleWizardNext is reachable from the live UI. 256 is a defensive
    // ceiling against pathological multi-MB pastes locking the renderer; the 64-char
    // cap is still enforced by handleWizardNext (extension-host side).
    return `
      <div class="wizard-header"><h1>Create Session</h1></div>
      <div class="form-group">
        <label for="session-name">Session Name</label>
        <input type="text" id="session-name" placeholder="My Team Session"
               value="${escapeHtml(state.sessionName)}" maxlength="100">
      </div>
      <div class="form-group">
        <label for="display-name">Your Display Name</label>
        <input type="text" id="display-name"
               placeholder="Your name (defaults to git config or OS username)"
               value="${escapeHtml(state.displayName || '')}" maxlength="256">
      </div>
      <div class="button-row">
        <div></div>
        <button class="btn btn-primary" id="btn-next" ${nextDisabled ? 'disabled' : ''}>Next</button>
      </div>
    `;
  }

  // Plan 07-05 — mode-select step (NEW). Copy is CONTEXT-LOCKED — reproduced
  // verbatim from UI-SPEC §Wizard Step 1.5. Do not paraphrase.
  function renderStepModeSelect(state) {
    const lanSelected = state.mode === 'lan';
    const cloudSelected = state.mode === 'cloud';
    return `
      <div class="wizard-header"><h1>Where will your team connect from?</h1></div>
      <fieldset class="mode-fieldset">
        <legend class="visually-hidden">Connection mode</legend>
        <label class="mode-select-card ${lanSelected ? 'selected' : ''}">
          <input type="radio" name="connection-mode" value="lan" ${lanSelected ? 'checked' : ''}>
          <span>
            <span class="mode-label">Same network (LAN)</span>
            <span class="mode-description">Fastest. No internet or relay needed.</span>
          </span>
        </label>
        <label class="mode-select-card ${cloudSelected ? 'selected' : ''}">
          <input type="radio" name="connection-mode" value="cloud" ${cloudSelected ? 'checked' : ''}>
          <span>
            <span class="mode-label">Different networks (Cloud)</span>
            <span class="mode-description">Connects via a relay server you deploy.</span>
          </span>
        </label>
      </fieldset>
      <div class="button-row">
        <button class="btn btn-secondary" id="btn-back">← Back</button>
        <button class="btn btn-primary" id="btn-next">Next →</button>
      </div>
    `;
  }

  // Plan 07-05 — LAN network configuration. Preserved verbatim from Phase 1/4.1
  // to keep the LAN flow byte-identical. Function name kept as renderStep2 so
  // the Backlog 999.2 source-grep test (wizardValidation.test.ts) still matches
  // the literal `function renderStep2(state) { ... return \`...\`;\n}` shape.
  function renderStep2(state) {
    let interfaceOptions = '';
    for (const iface of state.availableInterfaces) {
      const selected = iface.name === state.networkInterface ? 'selected' : '';
      interfaceOptions += `<option value="${escapeHtml(iface.name)}" ${selected}>${escapeHtml(iface.name)} (${escapeHtml(iface.address)})</option>`;
    }

    return `
      <div class="wizard-header"><h1>Network Configuration</h1></div>
      <div class="form-row">
        <div class="form-group">
          <label for="port">Port</label>
          <input type="number" id="port" value="${state.port}" min="1024" max="65535">
        </div>
        <div class="form-group">
          <label for="interface">Network Interface</label>
          <select id="interface">${interfaceOptions}</select>
        </div>
      </div>
      <div class="form-group">
        <label for="bandwidth">Max Payload Size (MB)</label>
        <input type="number" id="bandwidth" value="${state.maxPayloadMB}" min="1">
      </div>
      <div class="button-row">
        <button class="btn btn-secondary" id="btn-back">Back</button>
        <button class="btn btn-primary" id="btn-next">Next</button>
      </div>
    `;
  }

  // Plan 07-05 — Cloud network configuration (NEW). Copy CONTEXT-LOCKED.
  function renderStepNetworkCloud(state) {
    const reachable = state.relayUrlReachable;
    const resultText = reachable === true
      ? '✓ Relay reachable'
      : reachable === false
        ? '✗ Cannot reach relay'
        : '';
    const resultCls = reachable === true ? 'pass' : reachable === false ? 'fail' : '';
    const nextDisabled = reachable !== true;
    return `
      <div class="wizard-header"><h1>Relay configuration</h1></div>
      <p class="description">Your relay server forwards messages between your team. Members will connect to this URL.</p>
      <div class="form-group">
        <label for="relay-url">Relay URL</label>
        <input type="url" id="relay-url" placeholder="wss://your-relay.fly.dev"
               value="${escapeHtml(state.relayUrl || '')}" inputmode="url" autocomplete="off">
        <p class="description">Must start with wss:// — secure WebSocket required for cloud mode.</p>
        <a href="#" id="open-readme-link">Don't have a relay? Deploy one →</a>
      </div>
      <div class="test-connection-row">
        <button class="btn btn-secondary" data-test="test-connection" id="btn-test-connection">Test connection</button>
        <span id="test-connection-result" class="test-connection-result ${resultCls}" aria-live="polite">${escapeHtml(resultText)}</span>
      </div>
      <div class="form-group">
        <label for="bandwidth">Max Payload Size (MB)</label>
        <input type="number" id="bandwidth" value="${state.maxPayloadMB}" min="1">
      </div>
      <div class="button-row">
        <button class="btn btn-secondary" id="btn-back">← Back</button>
        <button class="btn btn-primary" id="btn-next" ${nextDisabled ? 'disabled' : ''}>Next →</button>
      </div>
    `;
  }

  // Invite-code reveal step. Function name kept as renderStep3 for the same
  // source-grep stability rationale as renderStep2 above.
  function renderStep3(state) {
    return `
      <div class="wizard-header"><h1>Session Credentials</h1></div>
      <div class="share-invite-code">${escapeHtml(state.inviteCode)}</div>
      <p class="description">Share this code with your team members so they can join your session.</p>
      <div class="button-row">
        <button class="btn btn-secondary" id="btn-back">Back</button>
        <button class="btn btn-primary" id="btn-start">Start Session</button>
      </div>
    `;
  }

  function renderShareScreen(state) {
    return `
      <div class="wizard-header"><h1>Share with Your Team</h1></div>
      <div class="session-active">Session Active</div>
      <div class="share-box">
        <div class="share-address">${escapeHtml(state.hostIp)}:${state.port}</div>
        <button class="copy-btn" id="copy-address">Copy Address</button>
      </div>
      <div class="share-box">
        <div class="share-invite-code">${escapeHtml(state.inviteCode)}</div>
        <button class="copy-btn" id="copy-code">Copy Invite Code</button>
      </div>
      <p class="description">Your session is live. Team members can join using the address and invite code above.</p>
    `;
  }

  // Plan 07-05 — Cloud share screen (NEW). Renders the canonical deep-link
  // literal `vscode://versioncon.versioncon/join?relay=...&session=...&code=...`
  // plus three separate copy-buttoned rows. Deep-link scheme prefix is
  // package.json's `{publisher}.{name}` = `versioncon.versioncon`.
  function renderShareScreenCloud(state) {
    // Phase 7 plan 07-13 (MD-03 Option A): pass state.bootstrapToken so the
    // rendered deep-link carries &bt=<URLencoded jwt>. Falls back to '' if
    // the state-update predates the bootstrapToken field (legacy webview);
    // buildDeepLink omits &bt= when the 4th arg is empty (LAN regression).
    const deepLink = buildDeepLink(state.relayUrl, state.sessionId || '', state.inviteCode, state.bootstrapToken || '');
    return `
      <div class="wizard-header"><h1>Cloud session active</h1></div>
      <div class="session-active">Cloud session live</div>
      <h2 style="margin-top:24px;margin-bottom:8px;font-size:1em;font-weight:600;">Share this invite link</h2>
      <p class="description">Anyone with this link can join from any network. Click to copy.</p>
      <div class="deep-link-box" id="deep-link-box">${escapeHtml(deepLink)}</div>
      <button class="copy-btn" id="copy-deep-link">Copy link</button>
      <h2 style="margin-top:32px;margin-bottom:8px;font-size:1em;font-weight:600;">Or share these three pieces</h2>
      <p class="description">Paste each into your teammates' Join Session form.</p>
      <div class="share-three-pieces">
        <div class="share-piece">
          <div>
            <div class="piece-label">Relay URL</div>
            <div class="piece-value">${escapeHtml(state.relayUrl || '')}</div>
          </div>
          <button class="copy-icon-btn" data-copy-target="relay">Copy</button>
        </div>
        <div class="share-piece">
          <div>
            <div class="piece-label">Session ID</div>
            <div class="piece-value">${escapeHtml(state.sessionId || '')}</div>
          </div>
          <button class="copy-icon-btn" data-copy-target="session">Copy</button>
        </div>
        <div class="share-piece">
          <div>
            <div class="piece-label">Invite Code</div>
            <div class="piece-value">${escapeHtml(state.inviteCode)}</div>
          </div>
          <button class="copy-icon-btn" data-copy-target="code">Copy</button>
        </div>
      </div>
      <p class="description" style="margin-top:16px;">Keep the invite code secret — anyone who has it can join.</p>
    `;
  }

  function attachListeners(state) {
    // Plan 04.1-03: step 1 has TWO inputs (sessionName + displayName).
    // Next is disabled until both are non-empty after trim.
    const nameInput = document.getElementById('session-name');
    const dispInput = document.getElementById('display-name');
    function updateNextDisabled() {
      const btn = document.getElementById('btn-next');
      if (!btn) return;
      // Backlog 999.2 fix: only step 1 gates Next on session-name + display-name presence.
      // Step 2+ render Next without a disabled attribute and must stay enabled — without
      // this guard, the listener fired on every render and disabled Next on every step
      // (nameInput/dispInput are null off step 1, so nameOk/dispOk evaluated to false).
      if (!nameInput || !dispInput) return;
      const nameOk = !!nameInput.value.trim();
      const dispOk = !!dispInput.value.trim();
      btn.disabled = !(nameOk && dispOk);
    }
    if (nameInput) {
      nameInput.addEventListener('input', updateNextDisabled);
      nameInput.focus();
    }
    if (dispInput) {
      dispInput.addEventListener('input', updateNextDisabled);
      // Plan 04.1 UAT Test 3 fix: webview <input> silently strips control characters on
      // paste before they reach .value (WebKit/Electron behavior). Read the raw clipboard
      // text via clipboardData.getData('text'), splice into the input value preserving
      // control chars, then preventDefault() so the default filtered paste does not run.
      // Round-trip: pasted bytes → input.value → postMessage → handleWizardNext, which
      // can now reach the 'Display name cannot contain control characters.' error path.
      dispInput.addEventListener('paste', (event) => {
        const cd = event.clipboardData;
        if (!cd) return; // older webviews — fall through to default behavior
        const text = cd.getData('text');
        if (text === '') return;
        event.preventDefault();
        const start = dispInput.selectionStart ?? dispInput.value.length;
        const end = dispInput.selectionEnd ?? dispInput.value.length;
        const before = dispInput.value.slice(0, start);
        const after = dispInput.value.slice(end);
        dispInput.value = before + text + after;
        const caret = start + text.length;
        dispInput.setSelectionRange(caret, caret);
        updateNextDisabled();
      });
    }
    updateNextDisabled();

    // Plan 07-05 — mode-select radios. Eagerly mirror the selection into
    // extension-host state so the Continue button gating on step 3 has the
    // right value to read before the user clicks Next.
    const modeRadios = document.querySelectorAll('input[name="connection-mode"]');
    modeRadios.forEach((radio) => {
      radio.addEventListener('change', (event) => {
        const mode = event.target.value;
        vscode.postMessage({ type: 'wizard-set-mode', payload: { mode } });
      });
    });

    // Plan 07-05 — relay URL input mirror (input event). Editing the URL
    // invalidates any prior test-connection result; extension-host clears
    // relayUrlReachable in handleSetRelayUrl.
    const relayUrlInput = document.getElementById('relay-url');
    if (relayUrlInput) {
      relayUrlInput.addEventListener('input', (event) => {
        vscode.postMessage({
          type: 'wizard-set-relay-url',
          payload: { relayUrl: event.target.value },
        });
      });
    }

    // Plan 07-05 — Test connection button. Performs the /healthz GET using
    // the wss:// → https:// transform, then posts the boolean result back to
    // the extension host (which stores it on state.relayUrlReachable + gates
    // Continue).
    const btnTestConnection = document.getElementById('btn-test-connection');
    if (btnTestConnection) {
      btnTestConnection.addEventListener('click', async () => {
        const inputEl = document.getElementById('relay-url');
        const currentValue = (inputEl && inputEl.value) || '';
        const resultSpan = document.getElementById('test-connection-result');
        if (!validateRelayUrl(currentValue)) {
          if (resultSpan) {
            resultSpan.textContent = 'Relay URL must start with wss://';
            resultSpan.className = 'test-connection-result fail';
          }
          vscode.postMessage({
            type: 'wizard-test-connection-result',
            payload: { ok: false },
          });
          return;
        }
        if (resultSpan) {
          resultSpan.textContent = 'Testing…';
          resultSpan.className = 'test-connection-result';
        }
        btnTestConnection.disabled = true;
        const result = await runTestConnection(currentValue);
        btnTestConnection.disabled = false;
        if (resultSpan) {
          resultSpan.textContent = result.message;
          resultSpan.className = 'test-connection-result ' + (result.ok ? 'pass' : 'fail');
        }
        vscode.postMessage({
          type: 'wizard-test-connection-result',
          payload: { ok: result.ok, sessions: result.sessions },
        });
      });
    }

    // Plan 07-05 — Deploy-your-own-relay help link. 07-06 will wire the
    // webview-open-readme handler to open the repo's relay/README.md.
    const openReadmeLink = document.getElementById('open-readme-link');
    if (openReadmeLink) {
      openReadmeLink.addEventListener('click', (event) => {
        event.preventDefault();
        vscode.postMessage({ type: 'webview-open-readme' });
      });
    }

    // Next button
    const btnNext = document.getElementById('btn-next');
    if (btnNext) {
      btnNext.addEventListener('click', () => {
        if (state.step === 1) {
          const sessionName =
            document.getElementById('session-name')?.value || '';
          const displayName =
            document.getElementById('display-name')?.value || '';
          vscode.postMessage({
            type: 'wizard-next',
            payload: { sessionName, displayName },
          });
        } else if (state.step === 2) {
          // Mode-select step. Read the currently-checked radio; fall back to
          // state.mode (already mirrored via the change handler).
          const checked = document.querySelector('input[name="connection-mode"]:checked');
          const mode = (checked && checked.value) || state.mode || 'lan';
          vscode.postMessage({ type: 'wizard-next', payload: { mode } });
        } else if (state.step === 3) {
          if (state.mode === 'cloud') {
            const relayUrl = document.getElementById('relay-url')?.value || '';
            const maxPayloadMB = parseFloat(document.getElementById('bandwidth')?.value || '50');
            vscode.postMessage({
              type: 'wizard-next',
              payload: { relayUrl, maxPayloadMB },
            });
          } else {
            const port = parseInt(document.getElementById('port')?.value || '0', 10);
            const networkInterface = document.getElementById('interface')?.value || '';
            const maxPayloadMB = parseFloat(document.getElementById('bandwidth')?.value || '50');
            vscode.postMessage({ type: 'wizard-next', payload: { port, networkInterface, maxPayloadMB } });
          }
        }
      });
    }

    // Back button
    const btnBack = document.getElementById('btn-back');
    if (btnBack) {
      btnBack.addEventListener('click', () => {
        vscode.postMessage({ type: 'wizard-back' });
      });
    }

    // Start Session button
    const btnStart = document.getElementById('btn-start');
    if (btnStart) {
      btnStart.addEventListener('click', () => {
        vscode.postMessage({ type: 'wizard-complete' });
      });
    }

    // Copy buttons (LAN share screen)
    const copyAddress = document.getElementById('copy-address');
    if (copyAddress) {
      copyAddress.addEventListener('click', () => {
        vscode.postMessage({ type: 'copy-to-clipboard', payload: { text: `${state.hostIp}:${state.port}` } });
        copyAddress.textContent = 'Copied!';
        setTimeout(() => { copyAddress.textContent = 'Copy Address'; }, 2000);
      });
    }

    const copyCode = document.getElementById('copy-code');
    if (copyCode) {
      copyCode.addEventListener('click', () => {
        vscode.postMessage({ type: 'copy-to-clipboard', payload: { text: state.inviteCode } });
        copyCode.textContent = 'Copied!';
        setTimeout(() => { copyCode.textContent = 'Copy Invite Code'; }, 2000);
      });
    }

    // Plan 07-05 — Cloud share-screen copy buttons. One full-width "Copy link"
    // button for the deep-link plus three icon-only per-piece copy buttons.
    const copyDeepLink = document.getElementById('copy-deep-link');
    if (copyDeepLink) {
      copyDeepLink.addEventListener('click', () => {
        // Phase 7 plan 07-13 (MD-03 Option A): same 4-arg buildDeepLink call as
        // the share-screen render — keep both call sites in lockstep so the
        // copied string matches the rendered string byte-for-byte.
        const deepLink = buildDeepLink(state.relayUrl, state.sessionId || '', state.inviteCode, state.bootstrapToken || '');
        vscode.postMessage({ type: 'copy-to-clipboard', payload: { text: deepLink } });
        copyDeepLink.textContent = 'Copied!';
        setTimeout(() => { copyDeepLink.textContent = 'Copy link'; }, 2000);
      });
    }

    const pieceCopyButtons = document.querySelectorAll('.copy-icon-btn[data-copy-target]');
    pieceCopyButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-copy-target');
        let text = '';
        if (target === 'relay') text = state.relayUrl || '';
        else if (target === 'session') text = state.sessionId || '';
        else if (target === 'code') text = state.inviteCode;
        vscode.postMessage({ type: 'copy-to-clipboard', payload: { text } });
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = original; }, 2000);
      });
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
})();
