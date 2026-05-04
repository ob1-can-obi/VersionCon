(function () {
  const vscode = acquireVsCodeApi();
  let currentState = null;

  vscode.postMessage({ type: 'webview-ready' });

  window.addEventListener('message', (event) => {
    const { type, payload } = event.data;
    if (type === 'state-update') {
      currentState = payload;
      render(payload);
    }
  });

  function render(state) {
    const root = document.getElementById('join-root');
    if (!root) return;

    let html = '<div class="join-container">';
    html += '<h1>Join Session</h1>';

    if (state.error) {
      html += `<div class="error-banner">${escapeHtml(state.error)}</div>`;
    }

    // Recent Sessions section
    if (state.recentSessions && state.recentSessions.length > 0) {
      html += '<div class="section">';
      html += '<div class="section-header">Recent Sessions</div>';
      for (const session of state.recentSessions) {
        html += `
          <div class="session-card">
            <div class="session-card-info">
              <div class="session-card-name">${escapeHtml(session.sessionName)}</div>
              <div class="session-card-detail">${escapeHtml(session.hostIp)}:${session.port} &middot; ${escapeHtml(session.displayName)}</div>
            </div>
            <div class="session-card-actions">
              <button class="btn-small" data-action="quick-connect"
                data-host="${escapeHtml(session.hostIp)}"
                data-port="${session.port}"
                data-name="${escapeHtml(session.displayName)}">Connect</button>
              <button class="btn-icon" data-action="remove-history"
                data-host="${escapeHtml(session.hostIp)}"
                data-port="${session.port}" title="Remove">&times;</button>
            </div>
          </div>`;
      }
      html += '</div>';
    }

    // Discovered Sessions section
    if (state.discoveredSessions && state.discoveredSessions.length > 0) {
      html += '<div class="section">';
      html += '<div class="section-header">Discovered on Network</div>';
      for (const session of state.discoveredSessions) {
        html += `
          <div class="session-card">
            <div class="session-card-info">
              <div class="session-card-name">${escapeHtml(session.name)} <span class="badge">mDNS</span></div>
              <div class="session-card-detail">${escapeHtml(session.host)}:${session.port}</div>
            </div>
            <div class="session-card-actions">
              <button class="btn-small" data-action="select-discovered"
                data-host="${escapeHtml(session.host)}"
                data-port="${session.port}">Select</button>
            </div>
          </div>`;
      }
      html += '</div>';
    }

    // Manual Join section
    html += '<div class="section">';
    html += '<div class="section-header">Join Manually</div>';
    html += `
      <div class="form-row">
        <div class="form-group">
          <label for="host-ip">Host IP</label>
          <input type="text" id="host-ip" placeholder="192.168.1.100" value="${escapeHtml(state.hostIp)}">
        </div>
        <div class="form-group" style="max-width: 100px;">
          <label for="port">Port</label>
          <input type="number" id="port" placeholder="3000" value="${escapeHtml(state.port)}">
        </div>
      </div>
      <div class="form-group">
        <label for="invite-code">Invite Code</label>
        <input type="text" id="invite-code" placeholder="ABC123" value="${escapeHtml(state.inviteCode)}">
      </div>
      <div class="form-group">
        <label for="display-name">Display Name</label>
        <input type="text" id="display-name" placeholder="Your Name" value="${escapeHtml(state.displayName)}">
      </div>
      <button class="btn btn-primary" id="btn-join" ${state.isConnecting ? 'disabled' : ''}>Join Session</button>
    `;
    html += '</div>';
    html += '</div>';

    // Loading overlay
    if (state.isConnecting) {
      html += '<div class="loading-overlay"><div class="loading-text">Connecting...</div></div>';
    }

    root.innerHTML = html;
    attachListeners(state);
  }

  function attachListeners(state) {
    // Join button
    const btnJoin = document.getElementById('btn-join');
    if (btnJoin) {
      btnJoin.addEventListener('click', () => {
        const hostIp = document.getElementById('host-ip')?.value || '';
        const port = document.getElementById('port')?.value || '';
        const inviteCode = document.getElementById('invite-code')?.value || '';
        const displayName = document.getElementById('display-name')?.value || '';
        vscode.postMessage({ type: 'join-connect', payload: { hostIp, port, inviteCode, displayName } });
      });
    }

    // Quick connect buttons
    document.querySelectorAll('[data-action="quick-connect"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const hostIp = btn.getAttribute('data-host') || '';
        const port = parseInt(btn.getAttribute('data-port') || '0', 10);
        const displayName = btn.getAttribute('data-name') || '';
        const inviteCode = document.getElementById('invite-code')?.value || '';
        vscode.postMessage({ type: 'join-quick-connect', payload: { hostIp, port, displayName, inviteCode } });
      });
    });

    // Remove history buttons
    document.querySelectorAll('[data-action="remove-history"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const hostIp = btn.getAttribute('data-host') || '';
        const port = parseInt(btn.getAttribute('data-port') || '0', 10);
        vscode.postMessage({ type: 'join-remove-history', payload: { hostIp, port } });
      });
    });

    // Select discovered buttons
    document.querySelectorAll('[data-action="select-discovered"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const host = btn.getAttribute('data-host') || '';
        const port = parseInt(btn.getAttribute('data-port') || '0', 10);
        vscode.postMessage({ type: 'join-select-discovered', payload: { host, port } });
      });
    });
  }

  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }
})();
