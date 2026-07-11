const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function getAuthedUser(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  return store.getUserBySession(token);
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function publicUserView(userId) {
  const userHabits = store.getHabitsForUser(userId);
  const loggedToday = store.getHabitsForDate(userId, store.todayStr());
  const habits = {};
  for (const h of userHabits) habits[h.id] = !!loggedToday[h.id];
  const streak = store.calcStreak(userId);
  const lastLogged = store.lastLoggedDate(userId);
  const lastWeight = store.lastWeightDate(userId);
  const weightDue = !lastWeight || store.daysSince(lastWeight) >= 7;
  return { habits, streak, lastLogged, weightDue, quiet: store.daysSince(lastLogged) >= 2 };
}

async function handleApi(req, res, url) {
  const { pathname } = url;

  // POST /api/auth  { email, name }
  if (pathname === '/api/auth' && req.method === 'POST') {
    const body = await readBody(req);
    if (!isValidEmail(body.email) || !body.name || !body.name.trim()) {
      return sendJson(res, 400, { error: 'Name and a valid email are required.' });
    }
    const user = store.getOrCreateUser(body.email, body.name);
    const token = store.createSession(user.id);
    return sendJson(res, 200, { token, user: { id: user.id, name: user.name, email: user.email } });
  }

  // GET /api/me
  if (pathname === '/api/me' && req.method === 'GET') {
    const user = getAuthedUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
    const view = publicUserView(user.id);
    const habits = store.getHabitsForUser(user.id);
    const encouragements = store.getUnseenEncouragements(user.id);
    store.markEncouragementsSeen(user.id);
    return sendJson(res, 200, {
      user: { id: user.id, name: user.name, email: user.email },
      habits,
      today: view.habits,
      streak: view.streak,
      lastLogged: view.lastLogged,
      weightDue: view.weightDue,
      encouragements: encouragements.map((e) => ({ message: e.message, createdAt: e.created_at })),
    });
  }

  // GET /api/habits
  if (pathname === '/api/habits' && req.method === 'GET') {
    const user = getAuthedUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
    return sendJson(res, 200, { habits: store.getHabitsForUser(user.id) });
  }

  // POST /api/habits  { label }
  if (pathname === '/api/habits' && req.method === 'POST') {
    const user = getAuthedUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
    const body = await readBody(req);
    const label = (body.label || '').trim();
    if (!label) return sendJson(res, 400, { error: 'Give the habit a short name.' });
    if (label.length > 120) return sendJson(res, 400, { error: 'Keep it short — under 120 characters.' });
    const habit = store.createHabit(user.id, label);
    return sendJson(res, 200, { habit });
  }

  // POST /api/habits/log  { habitId, completed, date? }
  if (pathname === '/api/habits/log' && req.method === 'POST') {
    const user = getAuthedUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
    const body = await readBody(req);
    const habit = store.getHabitById(body.habitId);
    if (!habit || habit.user_id !== user.id) {
      return sendJson(res, 400, { error: 'Unknown habit.' });
    }
    const date = body.date || store.todayStr();
    store.logHabit(user.id, body.habitId, date, !!body.completed);
    const view = publicUserView(user.id);
    return sendJson(res, 200, { today: view.habits, streak: view.streak });
  }

  // POST /api/weight { weight, unit, date? }
  if (pathname === '/api/weight' && req.method === 'POST') {
    const user = getAuthedUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
    const body = await readBody(req);
    const weight = Number(body.weight);
    if (!weight || weight <= 0 || weight > 500) {
      return sendJson(res, 400, { error: 'Enter a valid weight.' });
    }
    store.logWeight(user.id, weight, body.unit || 'kg', body.date || store.todayStr());
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/weight
  if (pathname === '/api/weight' && req.method === 'GET') {
    const user = getAuthedUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
    return sendJson(res, 200, { weights: store.getWeights(user.id) });
  }

  // POST /api/accountability/invite { partnerEmail }
  if (pathname === '/api/accountability/invite' && req.method === 'POST') {
    const user = getAuthedUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
    const body = await readBody(req);
    if (!isValidEmail(body.partnerEmail)) {
      return sendJson(res, 400, { error: 'Enter a valid email.' });
    }
    const { token } = store.createInvite(user.id, body.partnerEmail);
    const inviteUrl = `${url.origin}/invite/${token}`;
    return sendJson(res, 200, { inviteUrl, token });
  }

  // GET /api/accountability/invite/:token  (public, no auth)
  if (pathname.startsWith('/api/accountability/invite/') && req.method === 'GET') {
    const token = pathname.split('/').pop();
    const link = store.getInviteByToken(token);
    if (!link) return sendJson(res, 404, { error: 'Invite not found or expired.' });
    const owner = store.getUserById(link.owner_id);
    return sendJson(res, 200, {
      ownerName: owner ? owner.name : 'Someone',
      status: link.status,
    });
  }

  // POST /api/accountability/invite/:token/accept { email, name }
  if (pathname.startsWith('/api/accountability/invite/') && pathname.endsWith('/accept') && req.method === 'POST') {
    const parts = pathname.split('/');
    const token = parts[parts.length - 2];
    const link = store.getInviteByToken(token);
    if (!link) return sendJson(res, 404, { error: 'Invite not found or expired.' });
    const body = await readBody(req);
    if (!isValidEmail(body.email) || !body.name || !body.name.trim()) {
      return sendJson(res, 400, { error: 'Name and a valid email are required.' });
    }
    const partner = store.getOrCreateUser(body.email, body.name);
    store.acceptInvite(token, partner.id);
    const sessionToken = store.createSession(partner.id);
    const owner = store.getUserById(link.owner_id);
    return sendJson(res, 200, {
      token: sessionToken,
      user: { id: partner.id, name: partner.name, email: partner.email },
      ownerName: owner ? owner.name : 'Someone',
    });
  }

  // GET /api/accountability/watching
  if (pathname === '/api/accountability/watching' && req.method === 'GET') {
    const user = getAuthedUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
    const links = store.getLinksWatchedBy(user.id);
    const result = links.map((link) => {
      const owner = store.getUserById(link.owner_id);
      const view = publicUserView(link.owner_id);
      return {
        linkId: link.id,
        ownerName: owner ? owner.name : 'Someone',
        streak: view.streak,
        lastLogged: view.lastLogged,
        quiet: view.quiet,
        today: view.habits,
      };
    });
    return sendJson(res, 200, { watching: result });
  }

  // POST /api/accountability/:linkId/encourage { message }
  if (pathname.match(/^\/api\/accountability\/[^/]+\/encourage$/) && req.method === 'POST') {
    const user = getAuthedUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
    const linkId = pathname.split('/')[3];
    const link = store.getLinkById(linkId);
    if (!link || link.partner_id !== user.id) {
      return sendJson(res, 403, { error: 'Not allowed.' });
    }
    const body = await readBody(req);
    const message = (body.message || '').trim().slice(0, 280);
    if (!message) return sendJson(res, 400, { error: 'Message required.' });
    store.addEncouragement(linkId, message);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Not found.' });
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  // client-side routes fall back to index.html
  if (filePath.startsWith('/invite/')) filePath = '/index.html';
  const fullPath = path.join(PUBLIC_DIR, filePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (err) {
      console.error(err);
      sendJson(res, 500, { error: 'Server error.' });
    }
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`Goal-y-o running on http://localhost:${PORT}`);
});
