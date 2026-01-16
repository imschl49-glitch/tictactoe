import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function generateRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function emptyBoard() {
  return Array(9).fill(null);
}

const WIN_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

function getWinnerLine(board) {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return [a, b, c];
    }
  }
  return null;
}

function isDraw(board) {
  return board.every((v) => v !== null);
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const rooms = new Map();

function publicRoomState(room) {
  return {
    code: room.code,
    board: room.board,
    currentPlayer: room.currentPlayer,
    isGameOver: room.isGameOver,
    winnerLine: getWinnerLine(room.board),
    isDraw: !getWinnerLine(room.board) && isDraw(room.board),
    playerCount: Number(Boolean(room.players.X)) + Number(Boolean(room.players.O)),
    chat: room.chat.slice(-100),
  };
}

function send(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  for (const ws of room.sockets) send(ws, obj);
}

function resetRoomGame(room) {
  room.board = emptyBoard();
  room.currentPlayer = 'X';
  room.isGameOver = false;
}

function createRoom() {
  let code;
  do {
    code = generateRoomCode();
  } while (rooms.has(code));

  const room = {
    code,
    createdAt: Date.now(),
    sockets: new Set(),
    players: { X: null, O: null },
    board: emptyBoard(),
    currentPlayer: 'X',
    isGameOver: false,
    chat: [],
  };

  rooms.set(code, room);
  return room;
}

function assignRole(room, ws) {
  if (!room.players.X) {
    room.players.X = ws;
    return 'X';
  }
  if (!room.players.O) {
    room.players.O = ws;
    return 'O';
  }
  return 'SPECTATOR';
}

function removeSocketFromRoom(room, ws) {
  room.sockets.delete(ws);
  if (room.players.X === ws) room.players.X = null;
  if (room.players.O === ws) room.players.O = null;

  if (room.sockets.size === 0) {
    rooms.delete(room.code);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  let pathname = url.pathname;

  if (pathname === '/') pathname = '/index.html';

  const filePath = path.join(__dirname, pathname);
  const ext = path.extname(filePath);

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.role = null;

  send(ws, { type: 'hello' });

  ws.on('message', (data) => {
    const msg = safeJsonParse(data.toString());
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'create_room') {
      const room = createRoom();
      ws.roomCode = room.code;
      room.sockets.add(ws);
      ws.role = assignRole(room, ws);

      send(ws, { type: 'room_created', roomCode: room.code, role: ws.role });
      send(ws, { type: 'state', state: publicRoomState(room) });
      broadcast(room, { type: 'presence', state: publicRoomState(room) });
      return;
    }

    if (msg.type === 'join_room') {
      const roomCode = typeof msg.roomCode === 'string' ? msg.roomCode.trim().toUpperCase() : '';
      const room = rooms.get(roomCode);
      if (!room) {
        send(ws, { type: 'error', message: 'Room not found' });
        return;
      }

      ws.roomCode = room.code;
      room.sockets.add(ws);
      ws.role = assignRole(room, ws);

      send(ws, { type: 'room_joined', roomCode: room.code, role: ws.role });
      send(ws, { type: 'state', state: publicRoomState(room) });
      broadcast(room, { type: 'presence', state: publicRoomState(room) });
      return;
    }

    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room) {
      send(ws, { type: 'error', message: 'Not in a room' });
      return;
    }

    if (msg.type === 'move') {
      if (room.isGameOver) return;
      if (ws.role !== 'X' && ws.role !== 'O') return;
      if (ws.role !== room.currentPlayer) return;

      const index = Number(msg.index);
      if (!Number.isInteger(index) || index < 0 || index > 8) return;
      if (room.board[index] !== null) return;

      room.board[index] = ws.role;

      const winnerLine = getWinnerLine(room.board);
      if (winnerLine) {
        room.isGameOver = true;
      } else if (isDraw(room.board)) {
        room.isGameOver = true;
      } else {
        room.currentPlayer = room.currentPlayer === 'X' ? 'O' : 'X';
      }

      broadcast(room, { type: 'state', state: publicRoomState(room) });
      return;
    }

    if (msg.type === 'restart') {
      if (ws.role !== 'X' && ws.role !== 'O') return;
      resetRoomGame(room);
      broadcast(room, { type: 'state', state: publicRoomState(room) });
      return;
    }

    if (msg.type === 'chat') {
      const text = typeof msg.text === 'string' ? msg.text.trim() : '';
      if (!text) return;

      const player = ws.role === 'X' || ws.role === 'O' ? ws.role : 'SPECTATOR';
      const message = { player, text: text.slice(0, 200), time: Date.now() };
      room.chat = [...room.chat, message].slice(-100);

      broadcast(room, { type: 'chat', message });
      return;
    }

    if (msg.type === 'leave') {
      removeSocketFromRoom(room, ws);
      ws.roomCode = null;
      ws.role = null;
      broadcast(room, { type: 'presence', state: publicRoomState(room) });
      return;
    }
  });

  ws.on('close', () => {
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room) return;
    removeSocketFromRoom(room, ws);
    if (rooms.has(room.code)) {
      broadcast(room, { type: 'presence', state: publicRoomState(room) });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
