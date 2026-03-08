const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'whispering.db');

// Ensure data directory exists
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Performance settings
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Migrations (safe ALTER TABLE for existing DBs) ────────────────────────
try {
  db.exec(`ALTER TABLE rooms ADD COLUMN password TEXT`);
} catch (e) { /* column already exists */ }

// ── Schema ─────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    password   TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_active INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS sections (
    id         TEXT NOT NULL,
    room_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (id, room_id),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id     TEXT NOT NULL,
    target      TEXT NOT NULL DEFAULT 'all',
    target_name TEXT,
    text        TEXT NOT NULL,
    urgency     TEXT NOT NULL DEFAULT 'normal',
    sent_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS presets (
    id         TEXT NOT NULL,
    type       TEXT NOT NULL,
    text       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (id, type)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room   ON messages(room_id);
  CREATE INDEX IF NOT EXISTS idx_messages_target ON messages(room_id, target);
  CREATE INDEX IF NOT EXISTS idx_sections_room   ON sections(room_id);
`);

// ── Room helpers ─────────────────────────────────────────────────────────────

const stmts = {
  upsertRoom: db.prepare(`
    INSERT INTO rooms (id, name, password, created_at, last_active)
    VALUES (@id, @name, @password, unixepoch(), unixepoch())
    ON CONFLICT(id) DO UPDATE SET name = @name,
      password = COALESCE(@password, password),
      last_active = unixepoch()
  `),

  getPassword: db.prepare(`SELECT password FROM rooms WHERE id = ?`),

  touchRoom: db.prepare(`
    UPDATE rooms SET last_active = unixepoch() WHERE id = ?
  `),

  getRoom: db.prepare(`SELECT * FROM rooms WHERE id = ?`),

  // ── Sections ──
  upsertSection: db.prepare(`
    INSERT INTO sections (id, room_id, name)
    VALUES (@id, @roomId, @name)
    ON CONFLICT(id, room_id) DO UPDATE SET name = @name
  `),

  renameSection: db.prepare(`
    UPDATE sections SET name = @name WHERE id = @id AND room_id = @roomId
  `),

  deleteSection: db.prepare(`
    DELETE FROM sections WHERE id = @id AND room_id = @roomId
  `),

  getSections: db.prepare(`
    SELECT id, name FROM sections WHERE room_id = ? ORDER BY created_at ASC
  `),

  // ── Messages ──
  insertMessage: db.prepare(`
    INSERT INTO messages (room_id, target, target_name, text, urgency, sent_at)
    VALUES (@roomId, @target, @targetName, @text, @urgency, @sentAt)
  `),

  getLastMessages: db.prepare(`
    SELECT text, urgency, target, target_name as targetName, sent_at as timestamp
    FROM messages
    WHERE room_id = ? AND (target = 'all' OR target = ?)
    ORDER BY sent_at DESC
    LIMIT 30
  `),

  getLastMessageForSection: db.prepare(`
    SELECT text, urgency, target, target_name as targetName, sent_at as timestamp
    FROM messages
    WHERE room_id = ? AND (target = 'all' OR target = ?)
    ORDER BY sent_at DESC
    LIMIT 1
  `),

  // ── Cleanup ──
  pruneOldMessages: db.prepare(`
    DELETE FROM messages
    WHERE id NOT IN (
      SELECT id FROM messages WHERE room_id = messages.room_id
      ORDER BY sent_at DESC LIMIT 100
    )
    AND sent_at < (unixepoch() - 86400) * 1000
  `),

  pruneOldRooms: db.prepare(`
    DELETE FROM rooms WHERE last_active < unixepoch() - 604800
  `),
};

// ── Exported API ──────────────────────────────────────────────────────────────

function upsertRoom(id, name, password) {
  stmts.upsertRoom.run({ id, name, password: password || null });
}

function getRoomPassword(id) {
  const row = stmts.getPassword.get(id);
  return row ? row.password : null;
}

function touchRoom(id) {
  stmts.touchRoom.run(id);
}

function upsertSection(roomId, sectionId, sectionName) {
  stmts.upsertSection.run({ id: sectionId, roomId, name: sectionName });
}

function renameSection(roomId, sectionId, sectionName) {
  stmts.renameSection.run({ id: sectionId, roomId, name: sectionName });
}

function deleteSection(roomId, sectionId) {
  stmts.deleteSection.run({ id: sectionId, roomId });
}

function getSections(roomId) {
  return stmts.getSections.all(roomId);
}

function saveMessage(roomId, payload) {
  stmts.insertMessage.run({
    roomId,
    target:     payload.target     || 'all',
    targetName: payload.targetName || null,
    text:       payload.text,
    urgency:    payload.urgency    || 'normal',
    sentAt:     payload.timestamp  || Date.now(),
  });
}

function getLastMessageForSection(roomId, sectionId) {
  return stmts.getLastMessageForSection.get(roomId, sectionId) || null;
}

function getMessageHistory(roomId, sectionId) {
  const rows = stmts.getLastMessages.all(roomId, sectionId);
  return rows.reverse(); // oldest first
}

// ── Presets ───────────────────────────────────────────────────────────────────

const DEFAULT_PRESETS = {
  coordinator: [
    '⏰ 남은 시간 5분입니다',
    '🚀 속도를 조금 올려주세요',
    '🐢 속도를 조금 줄여주세요',
    '🎙️ 마이크 볼륨을 높여주세요',
    '🙋 질문이 있습니다',
    '☕ 잠시 쉬는 시간입니다',
  ],
  presenter: [
    '✋ 잠깐 멈춰주세요',
    '👍 준비됐습니다',
    '❓ 메시지를 못 봤어요',
    '🔊 잘 안들립니다',
    '⏱ 시간이 부족합니다',
    '✅ 잘 받았습니다',
    '🙋 질문 있습니다',
    '📡 화면 공유 확인 필요',
  ],
};

const presetStmts = {
  get:    db.prepare(`SELECT text FROM presets WHERE type = ? ORDER BY sort_order ASC`),
  count:  db.prepare(`SELECT COUNT(*) as n FROM presets WHERE type = ?`),
  delete: db.prepare(`DELETE FROM presets WHERE type = ?`),
  insert: db.prepare(`INSERT INTO presets (id, type, text, sort_order) VALUES (?, ?, ?, ?)`),
};

function getPresets(type) {
  const rows = presetStmts.get.all(type);
  if (rows.length === 0) return DEFAULT_PRESETS[type] || [];
  return rows.map(r => r.text);
}

function setPresets(type, texts) {
  const setAll = db.transaction((list) => {
    presetStmts.delete.run(type);
    list.forEach((text, i) => {
      presetStmts.insert.run(`${type}-${i}`, type, text, i);
    });
  });
  setAll(texts.filter(t => t && t.trim().length > 0));
}

// Run cleanup daily
function runCleanup() {
  try {
    stmts.pruneOldMessages.run();
    stmts.pruneOldRooms.run();
  } catch (e) {
    console.error('DB cleanup error:', e.message);
  }
}
setInterval(runCleanup, 24 * 60 * 60 * 1000);

module.exports = {
  upsertRoom,
  touchRoom,
  getRoomPassword,
  upsertSection,
  renameSection,
  deleteSection,
  getSections,
  saveMessage,
  getLastMessageForSection,
  getMessageHistory,
  getPresets,
  setPresets,
};
