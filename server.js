const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/*
  In-memory runtime state (augmented by SQLite for persistence):
  rooms: Map<roomId, {
    id, name, coordinator: ws|null,
    sections: Map<sectionId, { id, name, presenters: Set<ws>, lastMessage }>,
    timer: null | { seconds, running, startedAt }
  }>
*/
const rooms = new Map();
const clients = new Map(); // ws → { role, roomId, sectionId, id }
const lobbyClients = new Set();

// ── Section helpers ──────────────────────────────────────────────────────────

function getOrCreateSection(room, sectionId, sectionName) {
  if (!room.sections.has(sectionId)) {
    room.sections.set(sectionId, {
      id: sectionId,
      name: sectionName || sectionId,
      presenters: new Set(),
      lastMessage: null,
    });
    db.upsertSection(room.id, sectionId, sectionName || sectionId);
  }
  return room.sections.get(sectionId);
}

function sectionsSummary(room) {
  return [...room.sections.values()].map(s => ({
    id: s.id,
    name: s.name,
    presenterCount: s.presenters.size,
  }));
}

function totalPresenterCount(room) {
  let n = 0;
  for (const s of room.sections.values()) n += s.presenters.size;
  return n;
}

// ── Room helpers ─────────────────────────────────────────────────────────────

function getOrCreateRoom(roomId, name) {
  if (!rooms.has(roomId)) {
    // Try to restore sections from DB
    db.upsertRoom(roomId, name || roomId);
    const savedSections = db.getSections(roomId);

    const sectionsMap = new Map();
    for (const s of savedSections) {
      sectionsMap.set(s.id, {
        id: s.id,
        name: s.name,
        presenters: new Set(),
        lastMessage: null,
      });
    }

    rooms.set(roomId, {
      id: roomId,
      name: name || roomId,
      coordinator: null,
      sections: sectionsMap,
      timer: null,
      createdAt: Date.now(),
    });
  } else if (name) {
    // Update name if provided
    const room = rooms.get(roomId);
    if (room.name !== name) {
      room.name = name;
      db.upsertRoom(roomId, name);
    }
  }
  return rooms.get(roomId);
}

function roomSummary(room) {
  return {
    id: room.id,
    name: room.name,
    presenterCount: totalPresenterCount(room),
    sectionCount: room.sections.size,
    hasCoordinator: !!room.coordinator,
    createdAt: room.createdAt,
  };
}

// ── Broadcast helpers ────────────────────────────────────────────────────────

function broadcastRoomList() {
  const list = [...rooms.values()].map(roomSummary);
  const msg  = JSON.stringify({ type: 'room_list', payload: { rooms: list } });
  for (const ws of lobbyClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function broadcastToPresenters(roomId, data, target = 'all') {
  const room = rooms.get(roomId);
  if (!room) return;
  const msg = JSON.stringify(data);

  if (target === 'all') {
    for (const section of room.sections.values()) {
      for (const ws of section.presenters) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    }
  } else {
    const section = room.sections.get(target);
    if (!section) return;
    for (const ws of section.presenters) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }
}

function sendToCoordinator(roomId, data) {
  const room = rooms.get(roomId);
  if (!room || !room.coordinator) return;
  if (room.coordinator.readyState === WebSocket.OPEN) {
    room.coordinator.send(JSON.stringify(data));
  }
}

function notifyCoordinatorSections(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  sendToCoordinator(roomId, {
    type: 'sections_update',
    payload: { sections: sectionsSummary(room) },
  });
}

// ── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const { type, roomId, payload } = data;

    switch (type) {

      // ── Lobby ──
      case 'lobby_join': {
        lobbyClients.add(ws);
        clients.set(ws, { role: 'lobby', roomId: null, id: uuidv4() });
        const list = [...rooms.values()].map(roomSummary);
        ws.send(JSON.stringify({ type: 'room_list', payload: { rooms: list } }));
        break;
      }

      case 'lobby_leave':
        lobbyClients.delete(ws);
        break;

      // ── Join room ──
      case 'join': {
        const { role, name, sectionId, sectionName } = payload;
        const room = getOrCreateRoom(roomId, name);
        db.touchRoom(roomId);

        if (role === 'coordinator') {
          if (room.coordinator && room.coordinator !== ws && room.coordinator.readyState === WebSocket.OPEN) {
            room.coordinator.send(JSON.stringify({ type: 'kicked', payload: { reason: '다른 담당자가 접속했습니다.' } }));
          }
          room.coordinator = ws;
          if (name && room.name !== name) { room.name = name; db.upsertRoom(roomId, name); }
          clients.set(ws, { role: 'coordinator', roomId, sectionId: null, id: uuidv4() });

          ws.send(JSON.stringify({
            type: 'joined',
            payload: { role: 'coordinator', roomId, name: room.name, sections: sectionsSummary(room) },
          }));
          broadcastToPresenters(roomId, { type: 'coordinator_status', payload: { online: true } });

        } else {
          const sid    = sectionId   || 'general';
          const sname  = sectionName || (sectionId ? sectionId : '일반');
          const section = getOrCreateSection(room, sid, sname);
          section.presenters.add(ws);
          clients.set(ws, { role: 'presenter', roomId, sectionId: sid, id: uuidv4() });

          ws.send(JSON.stringify({
            type: 'joined',
            payload: { role: 'presenter', roomId, name: room.name, sectionId: sid, sectionName: section.name },
          }));

          // Replay last message for this section from DB
          const lastMsg = db.getLastMessageForSection(roomId, sid);
          if (lastMsg) {
            ws.send(JSON.stringify({ type: 'message', payload: lastMsg }));
          }
          if (room.timer) {
            ws.send(JSON.stringify({ type: 'timer', payload: room.timer }));
          }

          notifyCoordinatorSections(roomId);
        }

        broadcastRoomList();
        break;
      }

      // ── Section management ──
      case 'create_section': {
        const client = clients.get(ws);
        if (!client || client.role !== 'coordinator') return;
        const room = rooms.get(client.roomId);
        if (!room) return;
        const { sectionId: sid, sectionName: sname } = payload;
        if (!sid) return;
        getOrCreateSection(room, sid, sname || sid);
        notifyCoordinatorSections(client.roomId);
        break;
      }

      case 'delete_section': {
        const client = clients.get(ws);
        if (!client || client.role !== 'coordinator') return;
        const room = rooms.get(client.roomId);
        if (!room) return;
        const section = room.sections.get(payload.sectionId);
        if (!section) return;
        for (const presWs of section.presenters) {
          if (presWs.readyState === WebSocket.OPEN) {
            presWs.send(JSON.stringify({ type: 'section_deleted', payload: { sectionId: payload.sectionId } }));
          }
          clients.delete(presWs);
        }
        room.sections.delete(payload.sectionId);
        db.deleteSection(client.roomId, payload.sectionId);
        notifyCoordinatorSections(client.roomId);
        broadcastRoomList();
        break;
      }

      case 'rename_section': {
        const client = clients.get(ws);
        if (!client || client.role !== 'coordinator') return;
        const room = rooms.get(client.roomId);
        if (!room) return;
        const section = room.sections.get(payload.sectionId);
        if (!section) return;
        section.name = payload.sectionName || section.name;
        db.renameSection(client.roomId, payload.sectionId, section.name);
        for (const presWs of section.presenters) {
          if (presWs.readyState === WebSocket.OPEN) {
            presWs.send(JSON.stringify({ type: 'section_renamed', payload: { sectionId: section.id, sectionName: section.name } }));
          }
        }
        notifyCoordinatorSections(client.roomId);
        break;
      }

      // ── Message ──
      case 'message': {
        const client = clients.get(ws);
        if (!client || client.role !== 'coordinator') return;
        const room = rooms.get(client.roomId);
        if (!room) return;

        const target = payload.target || 'all';

        if (target === 'all') {
          for (const section of room.sections.values()) section.lastMessage = payload;
        } else {
          const section = room.sections.get(target);
          if (section) section.lastMessage = payload;
        }

        db.saveMessage(client.roomId, payload);
        broadcastToPresenters(client.roomId, { type: 'message', payload }, target);
        break;
      }

      case 'clear_message': {
        const client = clients.get(ws);
        if (!client || client.role !== 'coordinator') return;
        const room = rooms.get(client.roomId);
        if (!room) return;
        const target = payload?.target || 'all';
        if (target === 'all') {
          for (const section of room.sections.values()) section.lastMessage = null;
        } else {
          const section = room.sections.get(target);
          if (section) section.lastMessage = null;
        }
        broadcastToPresenters(client.roomId, { type: 'clear_message', payload: { target } }, target);
        break;
      }

      // ── Timer (room-wide) ──
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
        const target = payload?.target || 'all';
        broadcastToPresenters(client.roomId, { type: 'display_mode', payload }, target);
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

    const { role, roomId, sectionId } = client;
    const room = rooms.get(roomId);

    if (room) {
      if (role === 'coordinator') {
        room.coordinator = null;
        broadcastToPresenters(roomId, { type: 'coordinator_status', payload: { online: false } });
      } else if (sectionId) {
        const section = room.sections.get(sectionId);
        if (section) {
          section.presenters.delete(ws);
          notifyCoordinatorSections(roomId);
        }
      }

      // Remove from in-memory when everyone's gone (DB keeps history)
      if (!room.coordinator && totalPresenterCount(room) === 0) {
        rooms.delete(roomId);
      }

      broadcastRoomList();
    }

    clients.delete(ws);
  });

  ws.on('error', () => {});
});

// ── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/rooms', (req, res) => {
  res.json({ rooms: [...rooms.values()].map(roomSummary) });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);

  if (room) {
    return res.json({ room: roomSummary(room), sections: sectionsSummary(room) });
  }

  // Not in memory — check DB for saved sections
  const sections = db.getSections(roomId);
  res.json({ room: null, sections: sections.map(s => ({ ...s, presenterCount: 0 })) });
});

app.get('/api/rooms/:roomId/history', (req, res) => {
  const { roomId } = req.params;
  const { section = 'all' } = req.query;
  const messages = db.getMessageHistory(roomId, section);
  res.json({ messages });
});

// ── Page routes ───────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/coordinator', (req, res) => res.sendFile(path.join(__dirname, 'public', 'coordinator.html')));
app.get('/presenter', (req, res) => res.sendFile(path.join(__dirname, 'public', 'presenter.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Whispering server running at http://localhost:${PORT}`);
  console.log(`DB: ${require('./database').constructor?.name || 'SQLite'} ready`);
});
