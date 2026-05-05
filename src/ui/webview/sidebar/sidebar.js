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
    const root = document.getElementById('sidebar-root');
    if (!root) return;

    let html = '<div class="sidebar-container">';

    if (state.error) {
      html += `<div class="error-banner">${escapeHtml(state.error)}</div>`;
    }

    if (state.connectionStatus === 'disconnected' && !state.sessionName) {
      // Disconnected state
      html += '<h2>VersionCon</h2>';
      html += `<div class="status-badge"><span class="status-dot disconnected"></span> Not connected</div>`;
      html += '<div class="action-buttons">';
      html += '<button class="btn btn-primary" id="btn-host">Host Session</button>';
      html += '<button class="btn btn-primary" id="btn-join">Join Session</button>';
      html += '</div>';
    } else {
      // Connected / reconnecting state
      html += `<h2>${escapeHtml(state.sessionName || 'Session')}</h2>`;
      const statusText = state.connectionStatus === 'connected' ? 'Connected' : 'Reconnecting';
      html += `<div class="status-badge"><span class="status-dot ${state.connectionStatus}"></span> ${statusText}</div>`;

      // Members section
      html += `<div class="section-header">Members (${state.members.length})</div>`;
      html += '<ul class="member-list">';
      for (const member of state.members) {
        const initial = member.displayName.charAt(0).toUpperCase();
        const onlineCls = member.isOnline ? '' : 'offline';
        html += `
          <li class="member-item">
            <div class="member-avatar">${initial}</div>
            <div class="member-info">
              <div class="member-name">${escapeHtml(member.displayName)}</div>
              <div class="member-role">${member.role === 'host' ? '<span class="role-badge host">HOST</span>' : escapeHtml(member.role)}</div>
            </div>
            <span class="online-dot ${onlineCls}"></span>`;

        // Host admin: kick button (not for host themselves)
        if (state.role === 'host' && member.role !== 'host') {
          html += `<button class="btn-small" data-action="kick" data-member-id="${escapeHtml(member.id)}">Kick</button>`;
        }

        html += '</li>';
      }
      html += '</ul>';

      // Bandwidth section (host only)
      if (state.role === 'host' && state.bandwidthStats && state.bandwidthStats.length > 0) {
        html += '<div class="section-header">Bandwidth</div>';
        html += '<div class="bandwidth-section">';
        for (const stat of state.bandwidthStats) {
          const member = state.members.find(m => m.id === stat.memberId);
          const name = member ? member.displayName : stat.memberId.substring(0, 8);
          html += `<div class="bandwidth-item"><span>${escapeHtml(name)}</span><span>IN: ${stat.rateInKBps.toFixed(1)} KB/s | OUT: ${stat.rateOutKBps.toFixed(1)} KB/s</span></div>`;
        }
        html += '</div>';
      }

      // Disconnect button
      html += '<div class="action-buttons" style="margin-top: 16px;">';
      html += '<button class="btn btn-danger" id="btn-disconnect">Disconnect</button>';
      html += '</div>';
    }

    html += '</div>';
    root.innerHTML = html;
    attachListeners();
  }

  function attachListeners() {
    const btnHost = document.getElementById('btn-host');
    if (btnHost) {
      btnHost.addEventListener('click', () => {
        vscode.postMessage({ type: 'host-session' });
      });
    }

    const btnJoin = document.getElementById('btn-join');
    if (btnJoin) {
      btnJoin.addEventListener('click', () => {
        vscode.postMessage({ type: 'join-session' });
      });
    }

    const btnDisconnect = document.getElementById('btn-disconnect');
    if (btnDisconnect) {
      btnDisconnect.addEventListener('click', () => {
        vscode.postMessage({ type: 'disconnect' });
      });
    }

    document.querySelectorAll('[data-action="kick"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const memberId = btn.getAttribute('data-member-id');
        if (memberId) {
          vscode.postMessage({ type: 'kick-member', payload: { memberId } });
        }
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
