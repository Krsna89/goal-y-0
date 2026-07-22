(function () {
  const TOKEN_KEY = 'gratyent_token';

  let state = {
    token: localStorage.getItem(TOKEN_KEY) || null,
    user: null,
    habits: [],
    today: {},
    activeEncourageLinkId: null,
  };

  // ---------- helpers ----------

  function $(id) { return document.getElementById(id); }

  async function api(path, method, body) {
    const opts = { method: method || 'GET', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (state.token) opts.headers['Authorization'] = 'Bearer ' + state.token;
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  function showTopScreen(id) {
    ['screen-signin', 'screen-accept', 'screen-onboarding', 'screen-main'].forEach((s) => {
      $(s).classList.toggle('hidden', s !== id);
    });
  }

  function showSubView(id) {
    ['view-home', 'view-watching'].forEach((s) => {
      $(s).classList.toggle('hidden', s !== id);
    });
    $('nav-home').classList.toggle('active', id === 'view-home');
    $('nav-watching').classList.toggle('active', id === 'view-watching');
  }

  function setError(id, msg) {
    const el = $(id);
    if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  // ---------- sign in ----------

  $('signin-btn').addEventListener('click', async () => {
    const name = $('signin-name').value.trim();
    const email = $('signin-email').value.trim();
    setError('signin-error', null);
    if (!name || !email) { setError('signin-error', 'Please enter your name and email.'); return; }
    try {
      const data = await api('/api/auth', 'POST', { name, email });
      state.token = data.token;
      localStorage.setItem(TOKEN_KEY, data.token);
      await routeAfterAuth();
    } catch (e) {
      setError('signin-error', e.message);
    }
  });

  // First sign-up (0 habits yet) goes to onboarding; a returning sign-in
  // (already has habits) goes straight to the dashboard.
  async function routeAfterAuth() {
    const data = await api('/api/me', 'GET');
    state.user = data.user;
    state.habits = data.habits;
    state.today = data.today;
    if (!data.habits || data.habits.length === 0) {
      showOnboarding();
    } else {
      showTopScreen('screen-main');
      showSubView('view-home');
      renderHome(data);
    }
  }

  function showOnboarding() {
    $('onboarding-heading').textContent = "What's one habit you want to work on?";
    $('onboarding-sub').textContent = 'Something small and specific — you can add more later.';
    $('onboarding-add').textContent = 'Add habit';
    $('onboarding-input').value = '';
    $('onboarding-done-row').classList.add('hidden');
    setError('onboarding-error', null);
    showTopScreen('screen-onboarding');
    $('onboarding-input').focus();
  }

  $('onboarding-add').addEventListener('click', async () => {
    const label = $('onboarding-input').value.trim();
    setError('onboarding-error', null);
    if (!label) { setError('onboarding-error', 'Type a habit first.'); return; }
    try {
      await api('/api/habits', 'POST', { label });
      $('onboarding-input').value = '';
      $('onboarding-heading').textContent = 'Want to add another?';
      $('onboarding-sub').textContent = "Totally optional — one habit is plenty to start with.";
      $('onboarding-add').textContent = 'Add another';
      $('onboarding-done-row').classList.remove('hidden');
      $('onboarding-input').focus();
    } catch (e) {
      setError('onboarding-error', e.message);
    }
  });

  $('onboarding-finish').addEventListener('click', async () => {
    showTopScreen('screen-main');
    showSubView('view-home');
    await loadMe();
  });

  // ---------- accept invite ----------

  let inviteTokenFromUrl = null;

  async function loadAcceptScreen(token) {
    inviteTokenFromUrl = token;
    try {
      const data = await api('/api/accountability/invite/' + token, 'GET');
      $('accept-heading').textContent = `${data.ownerName} wants you to see their progress`;
    } catch (e) {
      $('accept-heading').textContent = 'This invite link is no longer valid.';
      $('accept-sub').textContent = 'Ask them to send you a new one.';
    }
    showTopScreen('screen-accept');
  }

  $('accept-btn').addEventListener('click', async () => {
    const name = $('accept-name').value.trim();
    const email = $('accept-email').value.trim();
    setError('accept-error', null);
    if (!name || !email) { setError('accept-error', 'Please enter your name and email.'); return; }
    try {
      const data = await api('/api/accountability/invite/' + inviteTokenFromUrl + '/accept', 'POST', { name, email });
      state.token = data.token;
      localStorage.setItem(TOKEN_KEY, data.token);
      window.history.replaceState({}, '', '/');
      await enterApp();
      showSubView('view-watching');
      loadWatching();
    } catch (e) {
      setError('accept-error', e.message);
    }
  });

  // ---------- home ----------

  async function loadMe() {
    const data = await api('/api/me', 'GET');
    state.user = data.user;
    state.habits = data.habits;
    state.today = data.today;
    renderHome(data);
  }

  function renderHome(data) {
    $('streak-num').textContent = data.streak;

    if (data.encouragements && data.encouragements.length) {
      const msgs = data.encouragements.map((e) => `"${e.message}"`).join(' ');
      $('encourage-banner').textContent = '💛 ' + msgs;
      $('encourage-banner').classList.remove('hidden');
    } else {
      $('encourage-banner').classList.add('hidden');
    }

    const list = $('habit-list');
    list.innerHTML = '';
    if (!data.habits || data.habits.length === 0) {
      list.innerHTML = '<div class="empty-state">No habits yet — add the first one below.</div>';
    }
    (data.habits || []).forEach((h) => {
      const done = !!data.today[h.id];
      const card = document.createElement('div');
      card.className = 'habit-card' + (done ? ' done' : '');
      card.innerHTML = `
        <div class="text">${h.label}</div>
        <div class="habit-check">${done ? '✓' : ''}</div>
      `;
      card.addEventListener('click', () => toggleHabit(h.id, !done));
      list.appendChild(card);
    });

    $('open-add-habit').textContent = (data.habits && data.habits.length) ? '+ Add another habit' : '+ Add a habit';
  }

  async function toggleHabit(habitId, completed) {
    try {
      const data = await api('/api/habits/log', 'POST', { habitId, completed });
      state.today[habitId] = completed;
      $('streak-num').textContent = data.streak;
      const list = $('habit-list');
      Array.from(list.children).forEach((card, i) => {
        const h = state.habits[i];
        if (!h) return;
        const done = !!state.today[h.id];
        card.classList.toggle('done', done);
        card.querySelector('.habit-check').textContent = done ? '✓' : '';
      });
    } catch (e) {
      alert(e.message);
    }
  }

  // ---------- add habit (from home) ----------

  $('open-add-habit').addEventListener('click', () => {
    $('add-habit-input').value = '';
    setError('add-habit-error', null);
    $('add-habit-modal').classList.remove('hidden');
  });
  $('add-habit-close').addEventListener('click', () => $('add-habit-modal').classList.add('hidden'));

  $('add-habit-save').addEventListener('click', async () => {
    const label = $('add-habit-input').value.trim();
    setError('add-habit-error', null);
    if (!label) { setError('add-habit-error', 'Type a habit first.'); return; }
    try {
      await api('/api/habits', 'POST', { label });
      $('add-habit-modal').classList.add('hidden');
      await loadMe();
    } catch (e) {
      setError('add-habit-error', e.message);
    }
  });

  // ---------- invite modal ----------

  $('open-invite').addEventListener('click', () => {
    $('invite-modal').classList.remove('hidden');
    $('invite-form').classList.remove('hidden');
    $('invite-result').classList.add('hidden');
    $('invite-email').value = '';
    $('invite-share-habits').checked = false;
    $('invite-send').disabled = false;
    $('invite-send').textContent = 'Create invite link';
    $('invite-close').textContent = 'Cancel';
    setError('invite-error', null);
  });
  $('invite-close').addEventListener('click', () => $('invite-modal').classList.add('hidden'));

  $('invite-send').addEventListener('click', async () => {
    const email = $('invite-email').value.trim();
    const shareHabitNames = $('invite-share-habits').checked;
    setError('invite-error', null);
    if (!email) { setError('invite-error', 'Enter their email.'); return; }
    $('invite-send').disabled = true;
    $('invite-send').textContent = 'Creating link…';
    try {
      const data = await api('/api/accountability/invite', 'POST', { partnerEmail: email, shareHabitNames });
      $('invite-link').value = data.inviteUrl;
      $('invite-form').classList.add('hidden');
      $('invite-result').classList.remove('hidden');
      $('invite-close').textContent = 'Close';
      try {
        $('invite-link').select();
        document.execCommand('copy');
        $('copy-invite').textContent = 'Copied!';
      } catch (copyErr) {
        // Clipboard copy is best-effort; the link is still visible to copy manually.
      }
    } catch (e) {
      setError('invite-error', e.message);
    } finally {
      $('invite-send').disabled = false;
      $('invite-send').textContent = 'Create invite link';
    }
  });

  $('copy-invite').addEventListener('click', () => {
    $('invite-link').select();
    document.execCommand('copy');
    $('copy-invite').textContent = 'Copied!';
    setTimeout(() => { $('copy-invite').textContent = 'Copy'; }, 1500);
  });

  // ---------- watching ----------

  async function loadWatching() {
    const list = $('watching-list');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    try {
      const data = await api('/api/accountability/watching', 'GET');
      if (!data.watching.length) {
        list.innerHTML = '<div class="empty-state">Nobody has nominated you yet. When someone shares an invite link with you, they\'ll show up here.</div>';
        return;
      }
      list.innerHTML = '';
      data.watching.forEach((w) => {
        const card = document.createElement('div');
        card.className = 'watch-card';
        const statusText = w.quiet
          ? (w.lastLogged ? `Hasn't logged in a couple of days` : 'Hasn\'t logged anything yet')
          : `Last logged ${w.lastLogged === todayStr() ? 'today' : w.lastLogged}`;
        const habitsHtml = w.habits && w.habits.length
          ? `<div class="watch-habit-list">` +
            w.habits.map((h) => `
              <div class="watch-habit ${h.completed ? 'done' : ''}">
                <span class="dot-mark">${h.completed ? '✓' : '·'}</span>
                <span>${h.label}</span>
              </div>
            `).join('') +
            `</div>`
          : '';
        card.innerHTML = `
          <div class="top">
            <div class="name">${w.ownerName}</div>
            <div class="streak">🔥 ${w.streak}</div>
          </div>
          <div class="status ${w.quiet ? 'quiet' : ''}">${statusText}</div>
          ${habitsHtml}
          <button class="btn-secondary encourage-btn">Send encouragement</button>
        `;
        card.querySelector('.encourage-btn').addEventListener('click', () => openEncourageModal(w.linkId, w.ownerName));
        list.appendChild(card);
      });
    } catch (e) {
      list.innerHTML = `<div class="empty-state">${e.message}</div>`;
    }
  }

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function openEncourageModal(linkId, name) {
    state.activeEncourageLinkId = linkId;
    $('encourage-heading').textContent = `Send encouragement to ${name}`;
    $('encourage-text').value = '';
    setError('encourage-error', null);
    $('encourage-modal').classList.remove('hidden');
  }

  $('encourage-close').addEventListener('click', () => $('encourage-modal').classList.add('hidden'));

  $('encourage-send').addEventListener('click', async () => {
    const message = $('encourage-text').value.trim();
    setError('encourage-error', null);
    if (!message) { setError('encourage-error', 'Write something first.'); return; }
    try {
      await api('/api/accountability/' + state.activeEncourageLinkId + '/encourage', 'POST', { message });
      $('encourage-modal').classList.add('hidden');
    } catch (e) {
      setError('encourage-error', e.message);
    }
  });

  // ---------- push notifications ----------

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  async function subscribeToPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      throw new Error("Notifications aren't supported on this device/browser.");
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      throw new Error('Notification permission was not granted.');
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await api('/api/push/vapid-public-key', 'GET');
      if (!key) throw new Error("Push isn't set up on the server yet.");
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }
    await api('/api/push/subscribe', 'POST', { subscription: sub.toJSON() });
    return sub;
  }

  async function loadNotificationPrefs() {
    try {
      const p = await api('/api/notifications/prefs', 'GET');
      $('reminder-toggle').checked = !!p.selfReminderEnabled;
      $('reminder-time').value = p.selfReminderTime || '19:00';
      $('reminder-time-row').classList.toggle('hidden', !p.selfReminderEnabled);

      const mode = p.partnerMode || 'off';
      document.querySelectorAll('input[name="partner-mode"]').forEach((el) => {
        el.checked = el.value === mode;
      });
      $('quiet-threshold').value = String(p.partnerQuietThreshold || 2);
      $('digest-freq').value = p.partnerDigestFreq || 'daily';
      $('quiet-threshold-row').classList.toggle('hidden', mode !== 'quiet');
      $('digest-freq-row').classList.toggle('hidden', mode !== 'digest');

      $('encouragement-toggle').checked = !!p.encouragementPushEnabled;
    } catch (e) {
      // Not signed in yet, or prefs endpoint unavailable — leave defaults.
    }
  }

  $('encouragement-toggle').addEventListener('change', async () => {
    $('encouragement-status').textContent = '';
    const enabled = $('encouragement-toggle').checked;
    try {
      if (enabled) await subscribeToPush();
      await api('/api/notifications/prefs', 'POST', { encouragementPushEnabled: enabled });
      $('encouragement-status').textContent = enabled
        ? "Saved — you'll get a push the moment someone cheers you on."
        : 'Turned off.';
    } catch (e) {
      $('encouragement-toggle').checked = !enabled;
      $('encouragement-status').textContent = e.message;
    }
  });

  $('reminder-toggle').addEventListener('change', () => {
    $('reminder-time-row').classList.toggle('hidden', !$('reminder-toggle').checked);
  });

  $('reminder-save').addEventListener('click', async () => {
    $('reminder-status').textContent = '';
    const enabled = $('reminder-toggle').checked;
    try {
      if (enabled) await subscribeToPush();
      await api('/api/notifications/prefs', 'POST', {
        selfReminderEnabled: enabled,
        selfReminderTime: $('reminder-time').value || '19:00',
        selfReminderTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      $('reminder-status').textContent = enabled
        ? "Saved — you'll get a reminder if you haven't logged by then."
        : 'Reminders turned off.';
    } catch (e) {
      $('reminder-status').textContent = e.message;
    }
  });

  document.querySelectorAll('input[name="partner-mode"]').forEach((el) => {
    el.addEventListener('change', () => {
      const mode = el.value;
      $('quiet-threshold-row').classList.toggle('hidden', mode !== 'quiet');
      $('digest-freq-row').classList.toggle('hidden', mode !== 'digest');
    });
  });

  $('partner-notify-save').addEventListener('click', async () => {
    $('partner-notify-status').textContent = '';
    const modeEl = document.querySelector('input[name="partner-mode"]:checked');
    const mode = modeEl ? modeEl.value : 'off';
    try {
      if (mode !== 'off') await subscribeToPush();
      await api('/api/notifications/prefs', 'POST', {
        partnerMode: mode,
        partnerQuietThreshold: Number($('quiet-threshold').value),
        partnerDigestFreq: $('digest-freq').value,
      });
      $('partner-notify-status').textContent = 'Saved.';
    } catch (e) {
      $('partner-notify-status').textContent = e.message;
    }
  });

  // ---------- nav ----------

  $('nav-home').addEventListener('click', () => { showSubView('view-home'); loadMe(); });
  $('nav-watching').addEventListener('click', () => { showSubView('view-watching'); loadWatching(); });
  $('nav-signout').addEventListener('click', () => {
    localStorage.removeItem(TOKEN_KEY);
    state.token = null;
    window.location.href = '/';
  });

  // ---------- boot ----------

  async function enterApp() {
    showTopScreen('screen-main');
    showSubView('view-home');
    await loadMe();
    await loadNotificationPrefs();
  }

  async function boot() {
    const path = window.location.pathname;
    if (path.startsWith('/invite/')) {
      const token = path.split('/invite/')[1];
      await loadAcceptScreen(token);
      return;
    }
    if (!state.token) {
      showTopScreen('screen-signin');
      return;
    }
    try {
      await enterApp();
    } catch (e) {
      localStorage.removeItem(TOKEN_KEY);
      state.token = null;
      showTopScreen('screen-signin');
    }
  }

  boot();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
})();
