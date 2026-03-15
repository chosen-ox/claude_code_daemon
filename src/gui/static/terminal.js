// Terminal functionality using xterm.js

// Terminal state
let terminal = null;
let fitAddon = null;
let terminalConnected = false;
let currentSession = null;
let terminalWebSocket = null;
let terminalReconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let lastSnapshotContent = '';  // Deduplicate: only redraw when content changes

// Initialize terminal when Terminal tab is shown
function initTerminal() {
  if (terminal) return; // Already initialized

  const terminalElement = document.getElementById('terminal');
  if (!terminalElement) return;

  // Create xterm.js terminal
  terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: '"Menlo", "DejaVu Sans Mono", "Consolas", "Monaco", monospace',
    theme: {
      background: '#000000',
      foreground: '#ffffff',
      cursor: '#ffffff',
      black: '#000000',
      red: '#cd3131',
      green: '#0dbc79',
      yellow: '#e5e510',
      blue: '#2472c8',
      magenta: '#bc3fbc',
      cyan: '#11a8cd',
      white: '#e5e5e5',
      brightBlack: '#666666',
      brightRed: '#f14c4c',
      brightGreen: '#23d18b',
      brightYellow: '#f5f543',
      brightBlue: '#3b8eea',
      brightMagenta: '#d670d6',
      brightCyan: '#29b8db',
      brightWhite: '#ffffff',
    },
    scrollback: 10000,
    tabStopWidth: 4,
  });

  // Attach terminal to DOM element
  terminal.open(terminalElement);

  // Load fit addon - @xterm/addon-fit v5 exposes FitAddon as window.FitAddon.FitAddon
  try {
    const FitAddonClass = window.FitAddon?.FitAddon || window.FitAddon;
    if (typeof FitAddonClass === 'function') {
      fitAddon = new FitAddonClass();
      terminal.loadAddon(fitAddon);
      fitAddon.fit();
    } else {
      console.warn('FitAddon not available, terminal will not auto-resize');
    }
  } catch (e) {
    console.warn('Failed to load FitAddon:', e);
  }

  // Handle terminal input
  terminal.onData(data => {
    if (terminalConnected && currentSession) {
      sendTerminalInput(data);
    }
  });

  // Handle terminal resize - sync new dimensions to server
  terminal.onResize(({ cols, rows }) => {
    if (terminalConnected && terminalWebSocket && terminalWebSocket.readyState === WebSocket.OPEN) {
      terminalWebSocket.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  window.addEventListener('resize', () => {
    if (fitAddon) {
      fitAddon.fit();
    }
  });

  // Apply theme based on current mode
  applyTerminalTheme();
}

// Apply terminal theme based on dark/light mode
function applyTerminalTheme() {
  if (!terminal) return;

  const isDarkMode = !document.body.classList.contains('light-mode');

  if (isDarkMode) {
    terminal.options.theme = {
      background: '#000000',
      foreground: '#ffffff',
      cursor: '#ffffff',
      black: '#000000',
      red: '#cd3131',
      green: '#0dbc79',
      yellow: '#e5e510',
      blue: '#2472c8',
      magenta: '#bc3fbc',
      cyan: '#11a8cd',
      white: '#e5e5e5',
      brightBlack: '#666666',
      brightRed: '#f14c4c',
      brightGreen: '#23d18b',
      brightYellow: '#f5f543',
      brightBlue: '#3b8eea',
      brightMagenta: '#d670d6',
      brightCyan: '#29b8db',
      brightWhite: '#ffffff',
    };
  } else {
    terminal.options.theme = {
      background: '#ffffff',
      foreground: '#000000',
      cursor: '#000000',
      black: '#000000',
      red: '#cd3131',
      green: '#0dbc79',
      yellow: '#e5e510',
      blue: '#2472c8',
      magenta: '#bc3fbc',
      cyan: '#11a8cd',
      white: '#e5e5e5',
      brightBlack: '#666666',
      brightRed: '#f14c4c',
      brightGreen: '#23d18b',
      brightYellow: '#f5f543',
      brightBlue: '#3b8eea',
      brightMagenta: '#d670d6',
      brightCyan: '#29b8db',
      brightWhite: '#ffffff',
    };
  }
}

// Connect to a tmux session
async function connectToSession(sessionName) {
  if (!sessionName) {
    showToast('Please select a session', 'warning');
    return;
  }

  // Initialize terminal if not already done
  initTerminal();

  // Disconnect existing connection
  if (terminalConnected) {
    disconnectTerminal();
  }

  try {
    // Hide placeholder
    const placeholder = document.getElementById('terminal-placeholder');
    if (placeholder) {
      placeholder.classList.add('hidden');
    }

    // Clear terminal
    terminal.clear();

    // Connect to terminal WebSocket - session name will be sent as first message
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/terminal`;

    terminalWebSocket = new WebSocket(wsUrl);

    terminalWebSocket.onopen = () => {
      // Send session name and current terminal dimensions
      terminalWebSocket.send(JSON.stringify({
        type: 'session',
        session: sessionName,
        cols: terminal.cols,
        rows: terminal.rows
      }));

      terminalConnected = true;
      currentSession = sessionName;
      terminalReconnectAttempts = 0;

      // Update UI
      document.getElementById('terminal-connect-btn').disabled = true;
      document.getElementById('terminal-disconnect-btn').disabled = false;

      // Write connection message
      terminal.writeln(`\r\n\x1b[32m✓ Connected to session: ${sessionName}\x1b[0m\r\n`);

      showToast(`Connected to ${sessionName}`, 'success');
    };

    terminalWebSocket.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'output') {
        // PTY stream - content is Latin-1 encoded binary; convert to Uint8Array for xterm.js
        const content = data.content;
        const buf = new Uint8Array(content.length);
        for (let i = 0; i < content.length; i++) buf[i] = content.charCodeAt(i) & 0xff;
        terminal.write(buf);
      } else if (data.type === 'snapshot') {
        // Legacy snapshot fallback (not used with node-pty)
        if (data.content !== lastSnapshotContent) {
          lastSnapshotContent = data.content;
          terminal.write('\x1b[H\x1b[2J\x1b[3J');
          terminal.write(data.content);
        }
      } else if (data.type === 'error') {
        terminal.writeln(`\r\n\x1b[31mError: ${data.message}\x1b[0m\r\n`);
        // Server-initiated error (e.g. session ended) — stop auto-reconnect
        terminalReconnectAttempts = MAX_RECONNECT_ATTEMPTS;
      } else if (data.type === 'ready') {
        terminal.writeln(`\x1b[36mTerminal ready. Waiting for session selection...\x1b[0m`);
      }
    };

    terminalWebSocket.onerror = (error) => {
      console.error('Terminal WebSocket error:', error);
      terminal.writeln(`\r\n\x1b[31m✗ Connection error\x1b[0m\r\n`);
    };

    terminalWebSocket.onclose = () => {
      terminalConnected = false;
      terminal.writeln(`\r\n\x1b[33m⚠ Connection closed\x1b[0m\r\n`);

      // Update UI
      document.getElementById('terminal-connect-btn').disabled = false;
      document.getElementById('terminal-disconnect-btn').disabled = true;

      // Try to reconnect
      if (terminalReconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        terminalReconnectAttempts++;
        terminal.writeln(`\r\n\x1b[33mAttempting to reconnect (${terminalReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...\x1b[0m\r\n`);
        setTimeout(() => {
          if (currentSession) {
            connectToSession(currentSession);
          }
        }, 2000);
      } else {
        currentSession = null;
        terminal.writeln(`\r\n\x1b[31m✗ Reconnection failed\x1b[0m\r\n`);

        // Show placeholder
        const placeholder = document.getElementById('terminal-placeholder');
        if (placeholder) {
          placeholder.classList.remove('hidden');
        }
      }
    };

  } catch (error) {
    console.error('Failed to connect to session:', error);
    showToast(`Failed to connect: ${error.message}`, 'error');
  }
}

// Disconnect from terminal
function disconnectTerminal() {
  if (terminalWebSocket) {
    terminalWebSocket.close();
    terminalWebSocket = null;
  }

  terminalConnected = false;
  currentSession = null;
  lastSnapshotContent = '';

  // Update UI
  document.getElementById('terminal-connect-btn').disabled = false;
  document.getElementById('terminal-disconnect-btn').disabled = true;

  // Show placeholder
  const placeholder = document.getElementById('terminal-placeholder');
  if (placeholder) {
    placeholder.classList.remove('hidden');
  }

  showToast('Disconnected from terminal', 'info');
}

// Send input to terminal
function sendTerminalInput(data) {
  if (!terminalWebSocket || terminalWebSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  terminalWebSocket.send(JSON.stringify({
    type: 'input',
    data: data
  }));
}

// Populate session select dropdown
async function populateSessionSelect() {
  const select = document.getElementById('terminal-session-select');
  if (!select) return;

  try {
    const response = await fetch('/api/sessions/tmux');
    const sessions = await response.json();

    // Clear existing options
    select.innerHTML = '<option value="">Select a session...</option>';

    // Add session options
    for (const session of sessions) {
      const option = document.createElement('option');
      option.value = session.name;
      option.textContent = `${session.name} ${session.claudePrompt ? '(' + session.claudePrompt + ')' : ''}`;
      select.appendChild(option);
    }

  } catch (error) {
    console.error('Failed to load sessions:', error);
  }
}

// Terminal tab initialization
function initTerminalTab() {
  // Set up event listeners
  const connectBtn = document.getElementById('terminal-connect-btn');
  const disconnectBtn = document.getElementById('terminal-disconnect-btn');
  const sessionSelect = document.getElementById('terminal-session-select');

  if (connectBtn) {
    connectBtn.addEventListener('click', () => {
      const sessionName = sessionSelect.value;
      connectToSession(sessionName);
    });
  }

  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', disconnectTerminal);
  }

  // Populate sessions when terminal tab is shown
  document.querySelector('.tab[data-tab="terminal"]')?.addEventListener('click', () => {
    populateSessionSelect();
    initTerminal();
  });
}

// Auto-trigger monitor controls
async function toggleAutoTriggerMonitor() {
  const enabled = document.getElementById('setting-auto-trigger').checked;
  const interval = parseInt(document.getElementById('setting-auto-trigger-interval').value) || 60;

  try {
    const response = await fetch('/api/auto-trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, interval })
    });

    if (response.ok) {
      showToast(`Auto-trigger monitor ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } else {
      showToast('Failed to update auto-trigger monitor', 'error');
    }
  } catch (error) {
    console.error('Failed to toggle auto-trigger monitor:', error);
    showToast('Failed to update auto-trigger monitor', 'error');
  }
}

// Get auto-trigger monitor status
async function getAutoTriggerStatus() {
  try {
    const response = await fetch('/api/auto-trigger');
    if (response.ok) {
      const status = await response.json();
      return status;
    }
  } catch (error) {
    console.error('Failed to get auto-trigger status:', error);
  }
  return null;
}

// Initialize terminal functionality when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTerminalTab);
} else {
  initTerminalTab();
}

// Export functions for use in app.js
window.terminalFunctions = {
  connectToSession,
  disconnectTerminal,
  populateSessionSelect,
  toggleAutoTriggerMonitor,
  getAutoTriggerStatus
};
