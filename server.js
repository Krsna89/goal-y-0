const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./db');
const webpush = require('./webpush');

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

  // POST /api/accountability/invite { partnerEmail, shareHabitNames? }
  if (pathname === '/api/accountability/invite' && req.method === 'POST') {
    const user = getAuthedUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
    const body = await readBody(req);
    if (!isValidEmail(body.partnerEmail)) {
      return sendJson(res, 400, { error: 'Enter a valid email.' });
    }
    const { token } = store.createInvite(user.id, body.partnerEmail, !!body.shareHabitNames);
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
      const entry = {
        linkId: link.id,
        ownerName: owner ? owner.name : 'Someone',
        streak: view.streak,
        lastLogged: view.lastLogged,
        quiet: view.quiet,
        today: view.habits,
      };
      if (link.share_habit_names) {
        entry.habits = store.getHabitsWithTodayStatus(link.owner_id);
      }
      return entry;
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

    // Encouragement is a direct response from a real person, so — unlike
    // the scheduled reminder sweep — push it immediately if the recipient
    // has opted in, rather than waiting for the next 5-minute sweep.
    try {
      const prefs = store.getNotificationPrefs(link.owner_id);
      if (prefs.encouragement_push_enabled) {
        const subs = store.getPushSubscriptionsForUser(link.owner_id);
        for (const sub of subs) {
          await sendAndCleanup(sub, {
            title: 'Goal-y-o',
            body: `${user.name} sent you encouragement: "${message}"`,
            tag: 'encouragement-' + linkId,
          });
        }
      }
    } catch (e) {
      console.error('Encouragement push failed:', e);
    }

    return sendJson(res, 200, { ok: true });
  }

  // GET /api/push/vapid-public-key  (public — needed before subscribing)
  if (pathname === '/api/push/vapid-public-key' && req.method === 'GET') {
    return sendJson(res, 200, { key: webpush.vapidPublicKey });
  }

  // POST /api/push/subscribe { subscription }
  if (pathname === '/api/push/subscribe' && req.method === 'POST') {
    const user = getAuthedUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return sendJson(res, 400, { error: 'Invalid subscription.' });
    }
    store.upsertPushSubscription(user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/push/unsubscribe { endpoint }
  if (pathname === '/api/push/unsubscribe' && req.method === 'POST') {
    const user = getAuthedUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
    const body = await readBody(req);
    if (body.endpoint) store.removePushSubscriptionForUser(user.id, body.endpoint);
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/notifications/prefs
  if (pathname === '/api/notifications/prefs' && req.method === 'GET') {
    const user = getAuthedUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
    const p = store.getNotificationPrefs(user.id);
    return sendJson(res, 200, {
      selfReminderEnabled: !!p.self_reminder_enabled,
      selfReminderTime: p.self_reminder_time,
      selfReminderTz: p.self_reminder_tz,
      partnerMode: p.partner_mode,
      partnerQuietThreshold: p.partner_quiet_threshold,
      partnerDigestFreq: p.partner_digest_freq,
      encouragementPushEnabled: !!p.encouragement_push_enabled,
    });
  }

  // POST /api/notifications/prefs { selfReminderEnabled?, selfReminderTime?, selfReminderTz?,
  //                                  partnerMode?, partnerQuietThreshold?, partnerDigestFreq?,
  //                                  encouragementPushEnabled? }
  if (pathname === '/api/notifications/prefs' && req.method === 'POST') {
    const user = getAuthedUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
    const body = await readBody(req);
    const fields = {};
    if (typeof body.selfReminderEnabled === 'boolean') {
      fields.self_reminder_enabled = body.selfReminderEnabled ? 1 : 0;
    }
    if (typeof body.selfReminderTime === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(body.selfReminderTime)) {
      fields.self_reminder_time = body.selfReminderTime;
    }
    if (typeof body.selfReminderTz === 'string' && body.selfReminderTz.length > 0 && body.selfReminderTz.length < 64) {
      fields.self_reminder_tz = body.selfReminderTz;
    }
    if (['off', 'quiet', 'digest'].includes(body.partnerMode)) {
      fields.partner_mode = body.partnerMode;
    }
    if (Number.isInteger(body.partnerQuietThreshold) && body.partnerQuietThreshold >= 1 && body.partnerQuietThreshold <= 14) {
      fields.partner_quiet_threshold = body.partnerQuietThreshold;
    }
    if (['daily', 'weekly'].includes(body.partnerDigestFreq)) {
      fields.partner_digest_freq = body.partnerDigestFreq;
    }
    if (typeof body.encouragementPushEnabled === 'boolean') {
      fields.encouragement_push_enabled = body.encouragementPushEnabled ? 1 : 0;
    }
    const p = store.updateNotificationPrefs(user.id, fields);
    return sendJson(res, 200, {
      selfReminderEnabled: !!p.self_reminder_enabled,
      selfReminderTime: p.self_reminder_time,
      selfReminderTz: p.self_reminder_tz,
      partnerMode: p.partner_mode,
      partnerQuietThreshold: p.partner_quiet_threshold,
      partnerDigestFreq: p.partner_digest_freq,
      encouragementPushEnabled: !!p.encouragement_push_enabled,
    });
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

// ---------- notification scheduler ----------
//
// Runs in-process (no separate cron job needed) since the Starter plan
// keeps this service always-on. Checks every few minutes for anyone due
// a self-reminder or a partner alert, and sends a Web Push notification.

async function sendAndCleanup(sub, payload) {
  try {
    const res = await webpush.sendPush(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload
    );
    if (res.statusCode === 404 || res.statusCode === 410) {
      store.removePushSubscription(sub.endpoint);
    } else if (res.statusCode >= 400) {
      console.error('Push send returned', res.statusCode, res.body);
    }
  } catch (e) {
    console.error('Push send failed:', e.message);
  }
}

async function runSelfReminders() {
  const now = new Date();
  const candidates = store.getUsersWithSelfReminderEnabled();
  for (const u of candidates) {
    const tz = u.self_reminder_tz || 'UTC';
    let hhmm, todayLocal;
    try {
      hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
      todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
    } catch (e) {
      continue; // unrecognized timezone string — skip rather than crash the sweep
    }
    if (hhmm !== u.self_reminder_time) continue;
    if (u.self_last_sent_date === todayLocal) continue;

    const loggedToday = store.getHabitsForDate(u.id, store.todayStr());
    const hasLoggedAny = Object.values(loggedToday).some(Boolean);
    if (!hasLoggedAny) {
      const subs = store.getPushSubscriptionsForUser(u.id);
      for (const sub of subs) {
        await sendAndCleanup(sub, {
          title: 'Goal-y-o',
          body: "You haven't logged your habit today — quick tap?",
          tag: 'self-reminder',
        });
      }
    }
    store.markSelfReminderSent(u.id, todayLocal);
  }
}

async function runPartnerAlerts() {
  const links = store.getAcceptedLinksWithPartnerPrefs();
  const byPartner = new Map();
  for (const link of links) {
    if (!byPartner.has(link.partner_id)) byPartner.set(link.partner_id, []);
    byPartner.get(link.partner_id).push(link);
  }

  for (const [partnerId, partnerLinks] of byPartner) {
    const mode = partnerLinks[0].partner_mode;

    if (mode === 'quiet') {
      for (const link of partnerLinks) {
        const owner = store.getUserById(link.owner_id);
        if (!owner) continue;
        const ownerLastLogged = store.lastLoggedDate(link.owner_id);
        const days = store.daysSince(ownerLastLogged);
        const key = ownerLastLogged || 'never';
        if (days >= (link.partner_quiet_threshold || 2) && link.quiet_alert_for_date !== key) {
          const subs = store.getPushSubscriptionsForUser(partnerId);
          for (const sub of subs) {
            await sendAndCleanup(sub, {
              title: 'Goal-y-o',
              body: `${owner.name} has gone quiet — check in?`,
              tag: 'partner-quiet-' + link.id,
            });
          }
          store.setQuietAlertFlag(link.id, key);
        }
      }
    } else if (mode === 'digest') {
      const freqDays = partnerLinks[0].partner_digest_freq === 'weekly' ? 7 : 1;
      const last = partnerLinks[0].partner_last_digest_date;
      const daysSinceDigest = last ? store.daysSince(last) : Infinity;
      if (daysSinceDigest >= freqDays) {
        const lines = partnerLinks
          .map((link) => {
            const owner = store.getUserById(link.owner_id);
            if (!owner) return null;
            const streak = store.calcStreak(link.owner_id);
            return `${owner.name}: ${streak}\u{1F525}`;
          })
          .filter(Boolean);
        if (lines.length) {
          const subs = store.getPushSubscriptionsForUser(partnerId);
          for (const sub of subs) {
            await sendAndCleanup(sub, {
              title: 'Goal-y-o check-in',
              body: lines.join(' · '),
              tag: 'partner-digest',
            });
          }
        }
        store.markPartnerDigestSent(partnerId, store.todayStr());
      }
    }
  }
}

async function runNotificationSweep() {
  if (!webpush.isConfigured) return;
  try {
    await runSelfReminders();
    await runPartnerAlerts();
  } catch (e) {
    console.error('Notification sweep failed:', e);
  }
}

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

server.listen(PORT, () => {
  console.log(`Goal-y-o running on http://localhost:${PORT}`);
  if (webpush.isConfigured) {
    console.log('Push notifications: configured — starting reminder sweep every 5 minutes.');
    setInterval(runNotificationSweep, SWEEP_INTERVAL_MS);
    runNotificationSweep();
  } else {
    console.log('Push notifications: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — notifications disabled.');
  }
});
