const statusEl = document.getElementById('status');
const restartBtn = document.getElementById('restart');
const cells = Array.from(document.querySelectorAll('.cell'));

const chatMessagesEl = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');

const createRoomBtn = document.getElementById('createRoom');
const joinRoomBtn = document.getElementById('joinRoom');
const roomCodeInput = document.getElementById('roomCode');
const leaveRoomBtn = document.getElementById('leaveRoom');
const reconnectBtn = document.getElementById('reconnect');
const roomInfoEl = document.getElementById('roomInfo');
const roleBadgeEl = document.getElementById('roleBadge');

let ws;
let roomCode = null;
let role = null;
let state = null;

let reconnectTimer;

function getLastRoomCode() {
  const raw = sessionStorage.getItem('tictactoe_last_room');
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  return code ? code : null;
}

function setLastRoomCode(code) {
  if (!code) {
    sessionStorage.removeItem('tictactoe_last_room');
    return;
  }
  sessionStorage.setItem('tictactoe_last_room', String(code).trim().toUpperCase());
}

function setStatus(text) {
  statusEl.textContent = text;
}

function canMakeMove() {
  if (!state) return false;
  if (!roomCode) return false;
  if (state.isGameOver) return false;
  if (role !== 'X' && role !== 'O') return false;
  return state.currentPlayer === role;
}

function renderState() {
  const board = state?.board ?? Array(9).fill(null);
  const winnerLine = Array.isArray(state?.winnerLine) ? state.winnerLine : null;

  for (let i = 0; i < cells.length; i++) {
    const v = board[i];
    const cell = cells[i];

    cell.textContent = v ?? '';
    cell.classList.toggle('x', v === 'X');
    cell.classList.toggle('o', v === 'O');
    cell.classList.toggle('win', Boolean(winnerLine && winnerLine.includes(i)));

    const disabled = !roomCode || state?.isGameOver || v !== null || !canMakeMove();
    cell.disabled = Boolean(disabled);
  }

  restartBtn.disabled = !roomCode;
  chatInput.disabled = !roomCode;
  document.getElementById('chatSend').disabled = !roomCode;

  if (!roomCode) {
    setStatus('Create or join a room to start playing');
    return;
  }

  if (state?.winnerLine) {
    setStatus(`Player ${board[state.winnerLine[0]]} wins!`);
    return;
  }

  if (state?.isDraw) {
    setStatus('Draw!');
    return;
  }

  const turn = state?.currentPlayer ? `Player ${state.currentPlayer}'s turn` : '';
  const you = role ? `You are ${role}` : '';
  setStatus([turn, you].filter(Boolean).join(' · '));
}

function handleCellClick(e) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!canMakeMove()) return;

  const btn = e.currentTarget;
  const index = Number(btn.dataset.index);
  if (!Number.isInteger(index)) return;

  ws.send(JSON.stringify({ type: 'move', index }));
}

for (const cell of cells) {
  cell.addEventListener('click', handleCellClick);
}

restartBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!roomCode) return;
  ws.send(JSON.stringify({ type: 'restart' }));
});

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

let chatMessages = [];

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendChatMessage(message) {
  const li = document.createElement('li');
  const cls = message.player === 'X' ? 'x' : message.player === 'O' ? 'o' : '';
  li.className = `chat-message ${cls}`;
  li.innerHTML = `
    <div class="chat-meta">${message.player} · ${escapeHtml(formatTime(message.time))}</div>
    <div class="chat-text">${escapeHtml(message.text)}</div>
  `;
  chatMessagesEl.appendChild(li);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function renderChat() {
  chatMessagesEl.innerHTML = '';
  for (const m of chatMessages) appendChatMessage(m);
}

function sendChatMessage() {
  const text = (chatInput.value ?? '').trim();
  if (!text) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!roomCode) return;

  ws.send(JSON.stringify({ type: 'chat', text: text.slice(0, 200) }));
  chatInput.value = '';
  chatInput.focus();
}

if (chatForm) {
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendChatMessage();
  });
}

if (chatInput) {
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });
}

renderChat();

function setRoomUi() {
  const connected = Boolean(roomCode);
  leaveRoomBtn.disabled = !connected;
  createRoomBtn.disabled = connected;
  joinRoomBtn.disabled = connected;
  roomCodeInput.disabled = connected;

  if (reconnectBtn) {
    reconnectBtn.disabled = Boolean(ws && ws.readyState === WebSocket.OPEN);
  }

  if (!connected) {
    roomInfoEl.textContent = 'Not connected';
    roleBadgeEl.textContent = '';
    chatMessages = [];
    renderChat();
    state = null;
    renderState();
    return;
  }

  roleBadgeEl.textContent = role ? `Role: ${role}` : '';
  roomInfoEl.textContent = `Room: ${roomCode}`;
}

function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }

  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    try {
      ws.close();
    } catch {
    }
  }

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}`);

  ws.addEventListener('open', () => {
    setRoomUi();

    const last = getLastRoomCode();
    if (last && !roomCode) {
      ws.send(JSON.stringify({ type: 'join_room', roomCode: last }));
      setStatus(`Connected. Rejoining room ${last}...`);
      return;
    }

    setStatus('Connected. Create or join a room');
  });

  ws.addEventListener('close', () => {
    roomCode = null;
    role = null;
    state = null;
    chatMessages = [];
    setRoomUi();
    setStatus('Disconnected. Tap Reconnect');

    reconnectTimer = setTimeout(() => {
      connect();
    }, 1500);
  });

  ws.addEventListener('message', (ev) => {
    const msg = (() => {
      try {
        return JSON.parse(ev.data);
      } catch {
        return null;
      }
    })();

    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'room_created' || msg.type === 'room_joined') {
      roomCode = msg.roomCode;
      role = msg.role;
      setLastRoomCode(roomCode);
      setRoomUi();
      return;
    }

    if (msg.type === 'state') {
      state = msg.state;
      if (Array.isArray(state?.chat)) {
        chatMessages = state.chat.slice(-100);
        renderChat();
      }
      renderState();
      return;
    }

    if (msg.type === 'chat') {
      if (!msg.message) return;
      chatMessages = [...chatMessages, msg.message].slice(-100);
      appendChatMessage(msg.message);
      return;
    }

    if (msg.type === 'error') {
      setStatus(msg.message || 'Error');
      return;
    }
  });
}

createRoomBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'create_room' }));
});

joinRoomBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const code = (roomCodeInput.value ?? '').trim().toUpperCase();
  if (!code) return;
  ws.send(JSON.stringify({ type: 'join_room', roomCode: code }));
});

roomCodeInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  joinRoomBtn.click();
});

leaveRoomBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!roomCode) return;
  ws.send(JSON.stringify({ type: 'leave' }));
  roomCode = null;
  role = null;
  state = null;
  chatMessages = [];
  setLastRoomCode(null);
  setRoomUi();
});

if (reconnectBtn) {
  reconnectBtn.addEventListener('click', () => {
    connect();
  });
}

setRoomUi();
connect();
