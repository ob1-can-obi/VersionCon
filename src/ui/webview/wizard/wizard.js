(function () {
  const vscode = acquireVsCodeApi();
  let currentState = null;

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

    // Step indicator (steps 1-3 only, not on share screen)
    if (state.step <= 3) {
      html += renderStepIndicator(state.step);
    }

    // Render current step
    switch (state.step) {
      case 1:
        html += renderStep1(state);
        break;
      case 2:
        html += renderStep2(state);
        break;
      case 3:
        html += renderStep3(state);
        break;
      case 4:
        html += renderShareScreen(state);
        break;
    }

    html += '</div>';
    root.innerHTML = html;

    // Attach event listeners after render
    attachListeners(state);
  }

  function renderStepIndicator(activeStep) {
    let html = '<div class="step-indicator">';
    for (let i = 1; i <= 3; i++) {
      const cls = i < activeStep ? 'completed' : i === activeStep ? 'active' : '';
      html += `<div class="step-dot ${cls}">${i}</div>`;
      if (i < 3) {
        const lineCls = i < activeStep ? 'completed' : '';
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
               value="${escapeHtml(state.displayName || '')}" maxlength="64">
      </div>
      <div class="button-row">
        <div></div>
        <button class="btn btn-primary" id="btn-next" ${nextDisabled ? 'disabled' : ''}>Next</button>
      </div>
    `;
  }

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

  function attachListeners(state) {
    // Plan 04.1-03: step 1 has TWO inputs (sessionName + displayName).
    // Next is disabled until both are non-empty after trim.
    const nameInput = document.getElementById('session-name');
    const dispInput = document.getElementById('display-name');
    function updateNextDisabled() {
      const btn = document.getElementById('btn-next');
      if (!btn) return;
      const nameOk = !!(nameInput && nameInput.value.trim());
      const dispOk = !!(dispInput && dispInput.value.trim());
      btn.disabled = !(nameOk && dispOk);
    }
    if (nameInput) {
      nameInput.addEventListener('input', updateNextDisabled);
      nameInput.focus();
    }
    if (dispInput) {
      dispInput.addEventListener('input', updateNextDisabled);
    }
    updateNextDisabled();

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
          const port = parseInt(document.getElementById('port')?.value || '0', 10);
          const networkInterface = document.getElementById('interface')?.value || '';
          const maxPayloadMB = parseFloat(document.getElementById('bandwidth')?.value || '50');
          vscode.postMessage({ type: 'wizard-next', payload: { port, networkInterface, maxPayloadMB } });
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

    // Copy buttons
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
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
})();
