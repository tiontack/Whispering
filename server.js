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

// Store sessions: sessionId -> { coordinator, presenters }
const sessions = new Map();

// Store client info: ws -> { role, sessionId, id }
const clients = new Map();

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      coordinator: null,
      presenters: new Set(),
      lastMessage: null,
      timer: null,
    });
  }
  return sessions.get(sessionId);
}

function broadcast(sessionId, data, excludeWs = null) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const message = JSON.stringify(data);
  const allClients = [session.coordinator, ...session.presenters].filter(Boolean);

  for (const ws of allClients) {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

function broadcastToPresenters(sessionId, data) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const message = JSON.stringify(data);
  for (const ws of session.presenters) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

function sendToCoordinator(sessionId, data) {
  const session = sessions.get(sessionId);
  if (!session || !session.coordinator) return;

  if (session.coordinator.readyState === WebSocket.OPEN) {
    session.coordinator.send(JSON.stringify(data));
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    const { type, sessionId, payload } = data;

    switch (type) {
      case 'join': {
        const { role } = payload;
        const session = getOrCreateSession(sessionId);
        clients.set(ws, { role, sessionId, id: uuidv4() });

        if (role === 'coordinator') {
          session.coordinator = ws;
          ws.send(JSON.stringify({ type: 'joined', payload: { role: 'coordinator', sessionId } }));
          // Notify presenters coordinator is online
          broadcastToPresenters(sessionId, { type: 'coordinator_status', payload: { online: true } });
        } else {
          session.presenters.add(ws);
          ws.send(JSON.stringify({ type: 'joined', payload: { role: 'presenter', sessionId } }));
          // Send last message/timer state to new presenter
          if (session.lastMessage) {
            ws.send(JSON.stringify({ type: 'message', payload: session.lastMessage }));
          }
          if (session.timer) {
            ws.send(JSON.stringify({ type: 'timer', payload: session.timer }));
          }
          // Notify coordinator a presenter joined
          sendToCoordinator(sessionId, {
            type: 'presenter_count',
            payload: { count: session.presenters.size },
          });
        }
        break;
      }

      case 'message': {
        const client = clients.get(ws);
        if (!client || client.role !== 'coordinator') return;
        const session = sessions.get(client.sessionId);
        if (!session) return;

        session.lastMessage = payload;
        broadcastToPresenters(client.sessionId, { type: 'message', payload });
        break;
      }

      case 'clear_message': {
        const client = clients.get(ws);
        if (!client || client.role !== 'coordinator') return;
        const session = sessions.get(client.sessionId);
        if (!session) return;

        session.lastMessage = null;
        broadcastToPresenters(client.sessionId, { type: 'clear_message' });
        break;
      }

      case 'timer': {
        const client = clients.get(ws);
        if (!client || client.role !== 'coordinator') return;
        const session = sessions.get(client.sessionId);
        if (!session) return;

        session.timer = payload;
        broadcastToPresenters(client.sessionId, { type: 'timer', payload });
        break;
      }

      case 'clear_timer': {
        const client = clients.get(ws);
        if (!client || client.role !== 'coordinator') return;
        const session = sessions.get(client.sessionId);
        if (!session) return;

        session.timer = null;
        broadcastToPresenters(client.sessionId, { type: 'clear_timer' });
        break;
      }

      case 'display_mode': {
        const client = clients.get(ws);
        if (!client || client.role !== 'coordinator') return;

        broadcastToPresenters(client.sessionId, { type: 'display_mode', payload });
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (!client) return;

    const { role, sessionId } = client;
    const session = sessions.get(sessionId);

    if (session) {
      if (role === 'coordinator') {
        session.coordinator = null;
        broadcastToPresenters(sessionId, { type: 'coordinator_status', payload: { online: false } });
      } else {
        session.presenters.delete(ws);
        sendToCoordinator(sessionId, {
          type: 'presenter_count',
          payload: { count: session.presenters.size },
        });
      }

      // Clean up empty sessions
      if (!session.coordinator && session.presenters.size === 0) {
        sessions.delete(sessionId);
      }
    }

    clients.delete(ws);
  });

  ws.on('error', () => {});
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/coordinator', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'coordinator.html'));
});
app.get('/presenter', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'presenter.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Whispering server running at http://localhost:${PORT}`);
});
