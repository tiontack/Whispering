const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// rooms: roomId -> { name, coordinator, presenters, lastMessage, timer, createdAt }
const rooms = new Map();

// clients: ws -> { role, roomId, id }
const clients = new Map();

// lobby subscribers: Set of ws connections watching room list
const lobbyClients = new Set();

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

function getOrCreateRoom(roomId, name) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      name: name || roomId,
      coordinator: null,
      presenters: new Set(),
      lastMessage: null,
      timer: null,
      createdAt: Date.now(),
    });
  }
  return rooms.get(roomId);
}

function roomSummary(room) {
  return {
    id: room.id,
    name: room.name,
    presenterCount: room.presenters.size,
    hasCoordinator: !!room.coordinator,
    createdAt: room.createdAt,
  };
}

function broadcastRoomList() {
  const list = [...rooms.values()].map(roomSummary);
  const msg = JSON.stringify({ type: 'room_list', payload: { rooms: list } });
  for (const ws of lobbyClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function broadcastToPresenters(roomId, data) {
  const room = rooms.get(roomId);
  if (!room) return;
  const msg = JSON.stringify(data);
  for (const ws of room.presenters) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function sendToCoordinator(roomId, data) {
  const room = rooms.get(roomId);
  if (!room || !room.coordinator) return;
  if (room.coordinator.readyState === WebSocket.OPEN) {
    room.coordinator.send(JSON.stringify(data));
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    const { type, roomId, payload } = data;

    switch (type) {

      // ── Lobby: watch room list ──
      case 'lobby_join': {
        lobbyClients.add(ws);
        clients.set(ws, { role: 'lobby', roomId: null, id: uuidv4() });
        const list = [...rooms.values()].map(roomSummary);
        ws.send(JSON.stringify({ type: 'room_list', payload: { rooms: list } }));
        break;
      }

      case 'lobby_leave': {
        lobbyClients.delete(ws);
        break;
      }

      // ── Room: join ──
      case 'join': {
        const { role, name } = payload;
        const room = getOrCreateRoom(roomId, name);
        clients.set(ws, { role, roomId, id: uuidv4() });

        if (role === 'coordinator') {
          // If room already has coordinator, kick old one
          if (room.coordinator && room.coordinator !== ws && room.coordinator.readyState === WebSocket.OPEN) {
            room.coordinator.send(JSON.stringify({ type: 'kicked', payload: { reason: '다른 담당자가 접속했습니다.' } }));
          }
          room.coordinator = ws;
          // Update room name if provided
          if (name) room.name = name;
          ws.send(JSON.stringify({ type: 'joined', payload: { role: 'coordinator', roomId, name: room.name } }));
          broadcastToPresenters(roomId, { type: 'coordinator_status', payload: { online: true } });
        } else {
          room.presenters.add(ws);
          ws.send(JSON.stringify({ type: 'joined', payload: { role: 'presenter', roomId, name: room.name } }));
          if (room.lastMessage) {
            ws.send(JSON.stringify({ type: 'message', payload: room.lastMessage }));
          }
          if (room.timer) {
            ws.send(JSON.stringify({ type: 'timer', payload: room.timer }));
          }
          sendToCoordinator(roomId, { type: 'presenter_count', payload: { count: room.presenters.size } });
        }

        broadcastRoomList();
        break;
      }

      // ── Message ──
      case 'message': {
        const client = clients.get(ws);
        if (!client || client.role !== 'coordinator') return;
        const room = rooms.get(client.roomId);
        if (!room) return;
        room.lastMessage = payload;
        broadcastToPresenters(client.roomId, { type: 'message', payload });
        break;
      }

      case 'clear_message': {
        const client = clients.get(ws);
        if (!client || client.role !== 'coordinator') return;
        const room = rooms.get(client.roomId);
        if (!room) return;
        room.lastMessage = null;
        broadcastToPresenters(client.roomId, { type: 'clear_message' });
        break;
      }

      // ── Timer ──
      case 'timer': {
        const client = clients.get(ws);
        if (!client || client.role !== 'coordinator') return;
        const room = rooms.get(client.roomId);
        if (!room) return;
        room.timer = payload;
        broadcastToPresenters(client.roomId, { type: 'timer', payload });
        break;
      }

      case 'clear_timer': {
        const client = clients.get(ws);
        if (!client || client.role !== 'coordinator') return;
        const room = rooms.get(client.roomId);
        if (!room) return;
        room.timer = null;
        broadcastToPresenters(client.roomId, { type: 'clear_timer' });
        break;
      }

      // ── Display mode ──
      case 'display_mode': {
        const client = clients.get(ws);
        if (!client || client.role !== 'coordinator') return;
        broadcastToPresenters(client.roomId, { type: 'display_mode', payload });
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  });

  ws.on('close', () => {
    lobbyClients.delete(ws);
    const client = clients.get(ws);
    if (!client || !client.roomId) { clients.delete(ws); return; }

    const { role, roomId } = client;
    const room = rooms.get(roomId);

    if (room) {
      if (role === 'coordinator') {
        room.coordinator = null;
        broadcastToPresenters(roomId, { type: 'coordinator_status', payload: { online: false } });
      } else {
        room.presenters.delete(ws);
        sendToCoordinator(roomId, { type: 'presenter_count', payload: { count: room.presenters.size } });
      }

      // Delete room when completely empty
      if (!room.coordinator && room.presenters.size === 0) {
        rooms.delete(roomId);
      }

      broadcastRoomList();
    }

    clients.delete(ws);
  });

  ws.on('error', () => {});
});

// ── REST API ──
app.get('/api/rooms', (req, res) => {
  const list = [...rooms.values()].map(roomSummary);
  res.json({ rooms: list });
});

// ── Page routes ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/coordinator', (req, res) => res.sendFile(path.join(__dirname, 'public', 'coordinator.html')));
app.get('/presenter', (req, res) => res.sendFile(path.join(__dirname, 'public', 'presenter.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Whispering server running at http://localhost:${PORT}`);
});
