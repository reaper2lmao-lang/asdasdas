// Minecraft Multi-Account Web Console Client
const SITE_PASSWORD = 'iberian123';
let backendUrl = localStorage.getItem('mc_backend_url') || '';
let socket = null;

function initSocket(url) {
  if (socket) {
    try { socket.disconnect(); } catch (e) {}
  }
  const opts = {
    transports: ['websocket', 'polling'],
    auth: {
      password: SITE_PASSWORD
    }
  };
  const s = url ? io(url, opts) : io(opts);

  s.on('connect', () => {
    console.log('Connected to backend server:', url || window.location.origin);
    const connAlert = document.getElementById('backendAlert');
    if (connAlert) connAlert.remove();
  });

  s.on('connect_error', (err) => {
    console.warn('Backend connection error:', err.message);
    showBackendAlert();
  });

  registerSocketListeners(s);
  return s;
}

function showBackendAlert() {
  if (document.getElementById('backendAlert')) return;
  const alertDiv = document.createElement('div');
  alertDiv.id = 'backendAlert';
  alertDiv.style.cssText = 'background:#451a03; border-bottom:1px solid #d97706; color:#fde68a; padding:8px 16px; font-size:0.8rem; display:flex; justify-content:space-between; align-items:center;';
  alertDiv.innerHTML = `
    <span>⚠️ Cannot reach Node.js backend. If hosting on Cloudflare Pages, make sure your backend is running and configured.</span>
    <button onclick="document.getElementById('btnOpenSettings').click()" style="background:#d97706; color:#000; border:none; padding:3px 8px; border-radius:4px; font-size:0.75rem; font-weight:bold; cursor:pointer;">Configure Backend</button>
  `;
  document.body.prepend(alertDiv);
}

// State
let sessions = new Map();
let activeBotId = null;
let commandHistory = [];
let historyIndex = -1;
let autoScroll = true;
let currentFilter = 'all';

// DOM Elements
const botTabsList = document.getElementById('botTabsList');
const chkBroadcastAll = document.getElementById('chkBroadcastAll');
const btnOpenNewBotModal = document.getElementById('btnOpenNewBotModal');
const newBotModal = document.getElementById('newBotModal');
const btnCloseModal = document.getElementById('btnCloseModal');
const btnCancelModal = document.getElementById('btnCancelModal');
const newBotForm = document.getElementById('newBotForm');

const btnOpenSettings = document.getElementById('btnOpenSettings');
const settingsModal = document.getElementById('settingsModal');
const btnCloseSettings = document.getElementById('btnCloseSettings');
const btnCancelSettings = document.getElementById('btnCancelSettings');
const settingsForm = document.getElementById('settingsForm');
const inputBackendUrl = document.getElementById('inputBackendUrl');


const activeStatusDot = document.getElementById('activeStatusDot');
const activeBotName = document.getElementById('activeBotName');
const activeBotServer = document.getElementById('activeBotServer');
const btnActiveDisconnect = document.getElementById('btnActiveDisconnect');
const btnActiveReconnect = document.getElementById('btnActiveReconnect');
const btnActiveRemove = document.getElementById('btnActiveRemove');

const msaBanner = document.getElementById('msaBanner');
const msaLink = document.getElementById('msaLink');
const msaCode = document.getElementById('msaCode');
const btnCopyMsa = document.getElementById('btnCopyMsa');

const terminalStream = document.getElementById('terminalStream');
const btnToggleScroll = document.getElementById('btnToggleScroll');
const btnClearLog = document.getElementById('btnClearLog');
const chatForm = document.getElementById('chatForm');
const cmdInput = document.getElementById('cmdInput');
const btnSendCmd = document.getElementById('btnSendCmd');

const activeAuthBadge = document.getElementById('activeAuthBadge');
const telePos = document.getElementById('telePos');
const teleVersion = document.getElementById('teleVersion');
const labelHealth = document.getElementById('labelHealth');
const barHealth = document.getElementById('barHealth');
const labelFood = document.getElementById('labelFood');
const barFood = document.getElementById('barFood');
const tabCount = document.getElementById('tabCount');
const playersList = document.getElementById('playersList');

// --- Minecraft Color Formatter (§ Codes) ---
const mcColorMap = {
  '0': '#000000', '1': '#0000aa', '2': '#00aa00', '3': '#00aaaa',
  '4': '#aa0000', '5': '#aa00aa', '6': '#ffaa00', '7': '#aaaaaa',
  '8': '#555555', '9': '#5555ff', 'a': '#55ff55', 'b': '#55ffff',
  'c': '#ff5555', 'd': '#ff55ff', 'e': '#ffff55', 'f': '#ffffff'
};

function formatMinecraftText(text) {
  if (!text) return '';
  if (!text.includes('§')) {
    return escapeHtml(text);
  }

  const parts = text.split('§');
  let result = escapeHtml(parts[0]);
  let currentColor = null;
  let isBold = false;
  let isItalic = false;
  let isUnderline = false;

  for (let i = 1; i < parts.length; i++) {
    const code = parts[i].charAt(0).toLowerCase();
    const content = escapeHtml(parts[i].slice(1));

    if (mcColorMap[code]) {
      currentColor = mcColorMap[code];
      isBold = false;
      isItalic = false;
      isUnderline = false;
    } else if (code === 'r') {
      currentColor = null;
      isBold = false;
      isItalic = false;
      isUnderline = false;
    } else if (code === 'l') {
      isBold = true;
    } else if (code === 'o') {
      isItalic = true;
    } else if (code === 'n') {
      isUnderline = true;
    }

    let style = '';
    if (currentColor) style += `color:${currentColor};`;
    if (isBold) style += `font-weight:bold;`;
    if (isItalic) style += `font-style:italic;`;
    if (isUnderline) style += `text-decoration:underline;`;

    if (style) {
      result += `<span style="${style}">${content}</span>`;
    } else {
      result += content;
    }
  }

  return result;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --- Session Management ---
function setActiveSession(id) {
  activeBotId = id;
  renderTabs();
  renderActiveView();
}

function renderTabs() {
  botTabsList.innerHTML = '';

  if (sessions.size === 0) {
    botTabsList.innerHTML = '<span style="color:#64748b; font-size:0.8rem; padding: 6px 0;">No active bots. Click "+ Launch New Account"</span>';
    return;
  }

  for (const [id, session] of sessions.entries()) {
    const tab = document.createElement('div');
    tab.className = `bot-tab ${id === activeBotId ? 'active' : ''}`;

    let dotClass = 'disconnected';
    if (session.status.connecting) dotClass = 'connecting';
    else if (session.status.connected) dotClass = 'connected';

    tab.innerHTML = `
      <span class="tab-dot ${dotClass}"></span>
      <span>${escapeHtml(session.config.username)}</span>
      <span class="tab-close" title="Close Session">✕</span>
    `;

    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) {
        e.stopPropagation();
        removeSession(id);
      } else {
        setActiveSession(id);
      }
    });

    botTabsList.appendChild(tab);
  }
}

function removeSession(id) {
  socket.emit('remove-bot', { botId: id });
  sessions.delete(id);
  if (activeBotId === id) {
    const nextKey = sessions.keys().next().value || null;
    setActiveSession(nextKey);
  } else {
    renderTabs();
  }
}

function renderActiveView() {
  const session = sessions.get(activeBotId);

  if (!session) {
    activeStatusDot.className = 'status-indicator-dot disconnected';
    activeBotName.textContent = 'No Account Selected';
    activeBotServer.textContent = '-';
    btnActiveDisconnect.disabled = true;
    btnActiveReconnect.disabled = true;
    btnActiveRemove.disabled = true;
    cmdInput.disabled = true;
    btnSendCmd.disabled = true;
    msaBanner.classList.add('hidden');

    telePos.textContent = 'X: 0 | Y: 0 | Z: 0';
    teleVersion.textContent = '-';
    activeAuthBadge.textContent = 'OFFLINE';
    labelHealth.textContent = '0 / 20';
    barHealth.style.width = '0%';
    labelFood.textContent = '0 / 20';
    barFood.style.width = '0%';
    tabCount.textContent = '0';
    playersList.innerHTML = '<div class="empty-players">Select or launch an account</div>';

    terminalStream.innerHTML = '<div class="empty-terminal-prompt"><span>No active console session. Launch an account using the button above.</span></div>';
    return;
  }

  // Active session header
  activeBotName.textContent = session.config.username;
  activeBotServer.textContent = `${session.config.host}:${session.config.port}`;
  
  if (session.status.connecting) {
    activeStatusDot.className = 'status-indicator-dot connecting';
  } else if (session.status.connected) {
    activeStatusDot.className = 'status-indicator-dot connected';
  } else {
    activeStatusDot.className = 'status-indicator-dot disconnected';
  }

  btnActiveDisconnect.disabled = !session.status.connected && !session.status.connecting;
  btnActiveReconnect.disabled = session.status.connected || session.status.connecting;
  btnActiveRemove.disabled = false;

  cmdInput.disabled = !session.status.connected && !chkBroadcastAll.checked;
  btnSendCmd.disabled = !session.status.connected && !chkBroadcastAll.checked;

  // Sidebar Telemetry
  activeAuthBadge.textContent = (session.config.auth || 'offline').toUpperCase();
  teleVersion.textContent = session.config.version || '1.8.9';
  updateTelemetryGauges(session);
  updatePlayersTab(session.status.players || []);

  // Render logs
  renderLogs();
}

function updateTelemetryGauges(session) {
  const h = session.status.health || 0;
  const f = session.status.food || 0;
  labelHealth.textContent = `${h} / 20`;
  barHealth.style.width = `${Math.min(100, Math.max(0, (h / 20) * 100))}%`;

  labelFood.textContent = `${f} / 20`;
  barFood.style.width = `${Math.min(100, Math.max(0, (f / 20) * 100))}%`;

  if (session.status.position) {
    telePos.textContent = `X: ${session.status.position.x} | Y: ${session.status.position.y} | Z: ${session.status.position.z}`;
  }
}

function updatePlayersTab(players) {
  tabCount.textContent = players.length;
  if (!players || players.length === 0) {
    playersList.innerHTML = '<div class="empty-players">No players online</div>';
    return;
  }

  playersList.innerHTML = '';
  players.forEach(p => {
    const item = document.createElement('div');
    item.className = 'player-item';
    item.innerHTML = `
      <div class="player-info-wrap">
        <img class="player-avatar" src="https://mc-heads.net/avatar/${encodeURIComponent(p.username)}/20" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'20\\' height=\\'20\\'><rect width=\\'20\\' height=\\'20\\' fill=\\'%23333\\'/></svg>'" alt="">
        <span>${formatMinecraftText(p.displayName || p.username)}</span>
      </div>
      <span class="player-ping">${p.ping || 0}ms</span>
    `;
    playersList.appendChild(item);
  });
}

function renderLogs() {
  const session = sessions.get(activeBotId);
  if (!session) return;

  terminalStream.innerHTML = '';
  const filtered = session.logs.filter(log => {
    if (currentFilter === 'all') return true;
    return log.type === currentFilter;
  });

  filtered.forEach(log => appendLogElement(log));
  if (autoScroll) {
    terminalStream.scrollTop = terminalStream.scrollHeight;
  }
}

function appendLogElement(log) {
  const row = document.createElement('div');
  row.className = `log-row ${log.type}`;

  let tag = '[SYSTEM]';
  if (log.type === 'chat') tag = '[CHAT]';
  if (log.type === 'sent') tag = '[SENT]';
  if (log.type === 'error') tag = '[ERROR]';

  let contentHtml = '';
  if (log.rawJson && log.rawJson.html) {
    contentHtml = log.rawJson.html;
  } else {
    contentHtml = formatMinecraftText(log.text);
  }

  row.innerHTML = `
    <span class="log-time">[${escapeHtml(log.time)}]</span>
    <span class="log-badge">${tag}</span>
    <span class="log-content">${contentHtml}</span>
  `;

  terminalStream.appendChild(row);
  if (autoScroll) {
    terminalStream.scrollTop = terminalStream.scrollHeight;
  }
}

// --- Socket Event Listeners ---
function registerSocketListeners(s) {
  s.on('init-sessions', (list) => {
    sessions.clear();
    list.forEach(item => {
      sessions.set(item.id, {
        id: item.id,
        config: item.config,
        status: item.status,
        logs: item.logs || []
      });
    });

    if (!activeBotId && sessions.size > 0) {
      setActiveSession(sessions.keys().next().value);
    } else {
      renderTabs();
      renderActiveView();
    }
  });

  s.on('session-created', (data) => {
    let existing = sessions.get(data.id);
    if (existing) {
      existing.config = data.config;
      existing.status = data.status;
    } else {
      sessions.set(data.id, {
        id: data.id,
        config: data.config,
        status: data.status,
        logs: []
      });
    }

    if (!activeBotId || activeBotId === data.id) {
      setActiveSession(data.id);
    } else {
      renderTabs();
    }
  });

  s.on('session-removed', ({ botId }) => {
    sessions.delete(botId);
    if (activeBotId === botId) {
      const nextKey = sessions.keys().next().value || null;
      setActiveSession(nextKey);
    } else {
      renderTabs();
    }
  });

  s.on('bot-status', ({ botId, status }) => {
    const session = sessions.get(botId);
    if (session) {
      session.status = { ...session.status, ...status };
      if (activeBotId === botId) {
        renderActiveView();
      }
      renderTabs();
    }
  });

  s.on('console-log', (log) => {
    if (log.botId === 'all') {
      for (const sess of sessions.values()) {
        sess.logs.push(log);
      }
      if (currentFilter === 'all' || currentFilter === log.type) {
        appendLogElement(log);
      }
      return;
    }

    const session = sessions.get(log.botId);
    if (session) {
      session.logs.push(log);
      if (session.logs.length > 500) session.logs.shift();

      if (activeBotId === log.botId) {
        if (currentFilter === 'all' || currentFilter === log.type) {
          appendLogElement(log);
        }
      }
    }
  });

  s.on('bot-stats', ({ botId, health, food }) => {
    const session = sessions.get(botId);
    if (session) {
      session.status.health = health;
      session.status.food = food;
      if (activeBotId === botId) {
        updateTelemetryGauges(session);
      }
    }
  });

  s.on('bot-pos', ({ botId, position }) => {
    const session = sessions.get(botId);
    if (session) {
      session.status.position = position;
      if (activeBotId === botId) {
        telePos.textContent = `X: ${position.x} | Y: ${position.y} | Z: ${position.z}`;
      }
    }
  });

  s.on('tab-list', ({ botId, players }) => {
    const session = sessions.get(botId);
    if (session) {
      session.status.players = players;
      if (activeBotId === botId) {
        updatePlayersTab(players);
      }
    }
  });

  s.on('msa-code', (data) => {
    if (activeBotId === data.botId) {
      msaBanner.classList.remove('hidden');
      msaLink.href = data.verification_uri;
      msaLink.textContent = data.verification_uri.replace(/^https?:\/\//, '');
      msaCode.textContent = data.user_code;
    }
  });
}

// Copy MSA Code
btnCopyMsa.addEventListener('click', () => {
  navigator.clipboard.writeText(msaCode.textContent).then(() => {
    btnCopyMsa.textContent = 'Copied!';
    setTimeout(() => { btnCopyMsa.textContent = 'Copy Code'; }, 2000);
  });
});

// --- Modal Handling ---
btnOpenNewBotModal.addEventListener('click', () => {
  newBotModal.classList.remove('hidden');
  document.getElementById('inputUsername').focus();
});

btnCloseModal.addEventListener('click', () => newBotModal.classList.add('hidden'));
btnCancelModal.addEventListener('click', () => newBotModal.classList.add('hidden'));

newBotForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = document.getElementById('inputUsername').value.trim();
  const host = document.getElementById('inputHost').value.trim();
  const port = parseInt(document.getElementById('inputPort').value) || 25565;
  const auth = document.getElementById('selectAuth').value;
  const version = document.getElementById('selectVersion').value;

  if (!username || !host) return;

  const botConfig = {
    username,
    host,
    port,
    auth,
    version
  };

  socket.emit('start-bot', botConfig);
  newBotModal.classList.add('hidden');
});

// --- Active Session Controls ---
btnActiveDisconnect.addEventListener('click', () => {
  if (!activeBotId) return;
  socket.emit('disconnect-bot', { botId: activeBotId });
});

btnActiveReconnect.addEventListener('click', () => {
  const session = sessions.get(activeBotId);
  if (!session) return;
  socket.emit('start-bot', {
    ...session.config,
    id: activeBotId
  });
});

btnActiveRemove.addEventListener('click', () => {
  if (!activeBotId) return;
  removeSession(activeBotId);
});

// Broadcast Toggle
chkBroadcastAll.addEventListener('change', () => {
  if (chkBroadcastAll.checked) {
    cmdInput.disabled = false;
    btnSendCmd.disabled = false;
    cmdInput.placeholder = "BROADCAST TO ALL BOTS: Type chat or /command...";
  } else {
    const session = sessions.get(activeBotId);
    const isConn = session && session.status.connected;
    cmdInput.disabled = !isConn;
    btnSendCmd.disabled = !isConn;
    cmdInput.placeholder = "Type chat or /command... (Enter to send, Up/Down for history)";
  }
});

// --- Command Bar & History ---
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const msg = cmdInput.value.trim();
  if (!msg) return;

  commandHistory.push(msg);
  historyIndex = commandHistory.length;

  const target = chkBroadcastAll.checked ? 'all' : activeBotId;
  socket.emit('send-chat', {
    botId: target,
    message: msg
  });

  cmdInput.value = '';
});

cmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp') {
    if (commandHistory.length > 0 && historyIndex > 0) {
      historyIndex--;
      cmdInput.value = commandHistory[historyIndex];
    }
    e.preventDefault();
  } else if (e.key === 'ArrowDown') {
    if (commandHistory.length > 0 && historyIndex < commandHistory.length - 1) {
      historyIndex++;
      cmdInput.value = commandHistory[historyIndex];
    } else {
      historyIndex = commandHistory.length;
      cmdInput.value = '';
    }
    e.preventDefault();
  }
});

// --- Quick Macros ---
document.querySelectorAll('.macro-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const cmd = chip.getAttribute('data-cmd');
    if (!cmd) return;
    const target = chkBroadcastAll.checked ? 'all' : activeBotId;
    socket.emit('send-chat', {
      botId: target,
      message: cmd
    });
  });
});

// --- Filter Buttons ---
document.querySelectorAll('.filter-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.getAttribute('data-filter');
    renderLogs();
  });
});

// Auto-Scroll Toggle
btnToggleScroll.addEventListener('click', () => {
  autoScroll = !autoScroll;
  btnToggleScroll.textContent = `Auto-Scroll: ${autoScroll ? 'ON' : 'OFF'}`;
  btnToggleScroll.classList.toggle('active', autoScroll);
});

// Clear Log
btnClearLog.addEventListener('click', () => {
  const session = sessions.get(activeBotId);
  if (session) {
    session.logs = [];
    terminalStream.innerHTML = '';
  }
});

// --- Settings Modal Handling ---
btnOpenSettings.addEventListener('click', () => {
  inputBackendUrl.value = localStorage.getItem('mc_backend_url') || '';
  settingsModal.classList.remove('hidden');
  inputBackendUrl.focus();
});

btnCloseSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));
btnCancelSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));

settingsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const newUrl = inputBackendUrl.value.trim();
  if (newUrl) {
    localStorage.setItem('mc_backend_url', newUrl);
  } else {
    localStorage.removeItem('mc_backend_url');
  }
  settingsModal.classList.add('hidden');
  socket = initSocket(newUrl);
});

// --- Lock Screen Authentication ---
const lockScreen = document.getElementById('lockScreen');
const lockForm = document.getElementById('lockForm');
const sitePasswordInput = document.getElementById('sitePasswordInput');
const btnTogglePasswordView = document.getElementById('btnTogglePasswordView');
const lockErrorMsg = document.getElementById('lockErrorMsg');
const btnLockApp = document.getElementById('btnLockApp');
const lockBox = document.querySelector('.lock-box');

function checkAuthentication() {
  const isUnlocked = sessionStorage.getItem('mc_unlocked') === 'true';
  if (isUnlocked) {
    lockScreen.classList.add('unlocked');
    socket = initSocket(backendUrl);
  } else {
    lockScreen.classList.remove('unlocked');
    if (sitePasswordInput) sitePasswordInput.focus();
  }
}

if (lockForm) {
  lockForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const entered = sitePasswordInput.value;
    if (entered === SITE_PASSWORD) {
      lockErrorMsg.classList.add('hidden');
      sessionStorage.setItem('mc_unlocked', 'true');
      lockScreen.classList.add('unlocked');
      sitePasswordInput.value = '';
      socket = initSocket(backendUrl);
    } else {
      lockErrorMsg.classList.remove('hidden');
      if (lockBox) {
        lockBox.classList.remove('shake-anim');
        void lockBox.offsetWidth; // trigger reflow
        lockBox.classList.add('shake-anim');
      }
      sitePasswordInput.select();
    }
  });
}

if (btnTogglePasswordView && sitePasswordInput) {
  btnTogglePasswordView.addEventListener('click', () => {
    const isPass = sitePasswordInput.getAttribute('type') === 'password';
    sitePasswordInput.setAttribute('type', isPass ? 'text' : 'password');
    btnTogglePasswordView.textContent = isPass ? '🔒' : '👁️';
  });
}

if (btnLockApp) {
  btnLockApp.addEventListener('click', () => {
    sessionStorage.removeItem('mc_unlocked');
    if (socket) {
      try { socket.disconnect(); } catch (e) {}
    }
    lockScreen.classList.remove('unlocked');
    if (sitePasswordInput) {
      sitePasswordInput.value = '';
      sitePasswordInput.focus();
    }
  });
}

// Initial authentication check
checkAuthentication();


