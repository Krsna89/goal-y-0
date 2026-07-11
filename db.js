const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const crypto = require('node:crypto');

// On a normal machine this just sits next to the code. On a host like
// Render, set DB_PATH to a path on your attached persistent disk (e.g.
// /var/data/gratyent.db) so the data survives restarts and redeploys.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'gratyent.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS habits (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS habit_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    habit_id TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, date, habit_id)
  );

  CREATE TABLE IF NOT EXISTS weight_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    weight REAL NOT NULL,
    unit TEXT NOT NULL DEFAULT 'kg',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accountability_links (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    partner_email TEXT NOT NULL,
    partner_id TEXT,
    invite_token TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    accepted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS encouragements (
    id TEXT PRIMARY KEY,
    link_id TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0
  );
`);

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const todayStr = () => new Date().toISOString().slice(0, 10);

// ---------- users / auth ----------

function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
}

function createUser(email, name) {
  const id = uuid();
  db.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)')
    .run(id, email.toLowerCase().trim(), name.trim(), now());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getOrCreateUser(email, name) {
  const existing = findUserByEmail(email);
  if (existing) return existing;
  return createUser(email, name);
}

function createSession(userId) {
  const token = uuid();
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
    .run(token, userId, now());
  return token;
}

function getUserBySession(token) {
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
}

// ---------- habits ----------

function createHabit(userId, label) {
  const id = uuid();
  db.prepare('INSERT INTO habits (id, user_id, label, created_at, archived) VALUES (?, ?, ?, ?, 0)')
    .run(id, userId, label.trim(), now());
  return db.prepare('SELECT * FROM habits WHERE id = ?').get(id);
}

function getHabitsForUser(userId) {
  return db.prepare('SELECT * FROM habits WHERE user_id = ? AND archived = 0 ORDER BY created_at ASC').all(userId);
}

function getHabitById(id) {
  return db.prepare('SELECT * FROM habits WHERE id = ?').get(id);
}

function logHabit(userId, habitId, date, completed) {
  const id = uuid();
  db.prepare(`
    INSERT INTO habit_logs (id, user_id, date, habit_id, completed, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, date, habit_id) DO UPDATE SET completed = excluded.completed
  `).run(id, userId, date, habitId, completed ? 1 : 0, now());
}

function getHabitsForDate(userId, date) {
  const rows = db.prepare('SELECT * FROM habit_logs WHERE user_id = ? AND date = ?').all(userId, date);
  const result = {};
  for (const r of rows) result[r.habit_id] = !!r.completed;
  return result;
}

function getAllLoggedDates(userId) {
  // dates where at least one habit was completed
  const rows = db.prepare(`
    SELECT DISTINCT date FROM habit_logs
    WHERE user_id = ? AND completed = 1
    ORDER BY date DESC
  `).all(userId);
  return rows.map((r) => r.date);
}

function calcStreak(userId) {
  const dates = new Set(getAllLoggedDates(userId));
  let streak = 0;
  let cursor = new Date();
  // if today not logged yet, start checking from yesterday so an
  // in-progress day doesn't zero out the streak
  if (!dates.has(todayStr())) {
    cursor.setDate(cursor.getDate() - 1);
  }
  for (;;) {
    const d = cursor.toISOString().slice(0, 10);
    if (dates.has(d)) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

function lastLoggedDate(userId) {
  const dates = getAllLoggedDates(userId);
  return dates.length ? dates[0] : null;
}

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const then = new Date(dateStr + 'T00:00:00Z').getTime();
  const now = new Date(todayStr() + 'T00:00:00Z').getTime();
  return Math.round((now - then) / (1000 * 60 * 60 * 24));
}

// ---------- weight ----------

function logWeight(userId, weight, unit, date) {
  const id = uuid();
  db.prepare('INSERT INTO weight_logs (id, user_id, date, weight, unit, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, userId, date, weight, unit || 'kg', now());
}

function getWeights(userId) {
  return db.prepare('SELECT * FROM weight_logs WHERE user_id = ? ORDER BY date DESC').all(userId);
}

function lastWeightDate(userId) {
  const row = db.prepare('SELECT date FROM weight_logs WHERE user_id = ? ORDER BY date DESC LIMIT 1').get(userId);
  return row ? row.date : null;
}

// ---------- accountability ----------

function createInvite(ownerId, partnerEmail) {
  const id = uuid();
  const token = uuid();
  db.prepare(`
    INSERT INTO accountability_links (id, owner_id, partner_email, invite_token, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(id, ownerId, partnerEmail.toLowerCase().trim(), token, now());
  return { id, token };
}

function getInviteByToken(token) {
  return db.prepare('SELECT * FROM accountability_links WHERE invite_token = ?').get(token);
}

function acceptInvite(token, partnerId) {
  db.prepare(`
    UPDATE accountability_links
    SET status = 'accepted', partner_id = ?, accepted_at = ?
    WHERE invite_token = ?
  `).run(partnerId, now(), token);
}

function getLinksOwnedBy(userId) {
  return db.prepare('SELECT * FROM accountability_links WHERE owner_id = ?').all(userId);
}

function getLinksWatchedBy(userId) {
  return db.prepare("SELECT * FROM accountability_links WHERE partner_id = ? AND status = 'accepted'").all(userId);
}

function getLinkById(id) {
  return db.prepare('SELECT * FROM accountability_links WHERE id = ?').get(id);
}

function addEncouragement(linkId, message) {
  const id = uuid();
  db.prepare('INSERT INTO encouragements (id, link_id, message, created_at, seen) VALUES (?, ?, ?, ?, 0)')
    .run(id, linkId, message, now());
}

function getUnseenEncouragements(ownerId) {
  const rows = db.prepare(`
    SELECT e.*, l.owner_id, l.partner_id
    FROM encouragements e
    JOIN accountability_links l ON l.id = e.link_id
    WHERE l.owner_id = ? AND e.seen = 0
    ORDER BY e.created_at DESC
  `).all(ownerId);
  return rows;
}

function markEncouragementsSeen(ownerId) {
  db.prepare(`
    UPDATE encouragements
    SET seen = 1
    WHERE seen = 0 AND link_id IN (SELECT id FROM accountability_links WHERE owner_id = ?)
  `).run(ownerId);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

module.exports = {
  uuid,
  now,
  todayStr,
  getOrCreateUser,
  findUserByEmail,
  createSession,
  getUserBySession,
  getUserById,
  createHabit,
  getHabitsForUser,
  getHabitById,
  logHabit,
  getHabitsForDate,
  calcStreak,
  lastLoggedDate,
  daysSince,
  logWeight,
  getWeights,
  lastWeightDate,
  createInvite,
  getInviteByToken,
  acceptInvite,
  getLinksOwnedBy,
  getLinksWatchedBy,
  getLinkById,
  addEncouragement,
  getUnseenEncouragements,
  markEncouragementsSeen,
};
