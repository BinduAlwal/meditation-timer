// Meditation Timer — PWA build
// Pure web: Wake Lock API, Media Session API, localStorage. No Capacitor.

(function() {
  'use strict';

  // --- State ---
  const DEFAULT_INTERVALS = [
    { name: 'Settling in', seconds: 120 },
    { name: 'Breathing', seconds: 300 },
    { name: 'Closing', seconds: 60 }
  ];
  let intervals = JSON.parse(JSON.stringify(DEFAULT_INTERVALS));
  let currentIdx = 0;
  let remaining = 0;
  let timer = null;
  let paused = false;
  let sessionStartMs = 0;

  // Named session tracking
  let currentSessionId = null;
  let currentSessionName = null;
  let isDirty = false;

  // Audio
  let audioCtx = null;
  let silentSource = null;
  const audioBuffers = {};
  const chimeFiles = {
    bell: 'audio/bell.wav',
    bowl: 'audio/bowl.wav',
    gong: 'audio/gong.wav',
    wood: 'audio/wood.wav'
  };

  // Wake Lock API — replaces KeepAwake plugin
  let wakeLock = null;

  // --- Helpers ---
  const $ = id => document.getElementById(id);

  function fmt(s) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m + ':' + String(sec).padStart(2, '0');
  }

  function totalSeconds() {
    return intervals.reduce((a, b) => a + b.seconds, 0);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function uid() {
    return 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function formatDate(ms) {
    const d = new Date(ms);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // --- SessionStore: storage abstraction ---
  // Swap `backend` below to wire iCloud KVS, Supabase, Firebase, etc. later.
  const SessionStore = (function() {
    const STORAGE_KEY = 'med_sessions_v1';
    const SCHEMA_VERSION = 1;

    const backend = {
      readAll() {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (!raw) return [];
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed : [];
        } catch (e) { return []; }
      },
      writeAll(list) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
          return true;
        } catch (e) { return false; }
      }
    };

    function list() {
      return backend.readAll().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }

    function get(id) {
      return backend.readAll().find(s => s.id === id) || null;
    }

    function existsByName(name, exceptId) {
      const needle = name.trim().toLowerCase();
      return backend.readAll().some(s =>
        s.id !== exceptId && (s.name || '').trim().toLowerCase() === needle
      );
    }

    function save(session) {
      const all = backend.readAll();
      const now = Date.now();
      const idx = all.findIndex(s => s.id === session.id);
      const clean = {
        id: session.id || uid(),
        name: (session.name || 'Untitled').trim(),
        intervals: session.intervals.map(iv => ({
          name: iv.name, seconds: iv.seconds
        })),
        chime: session.chime || null,
        createdAt: idx >= 0 ? all[idx].createdAt : now,
        updatedAt: now,
        schemaVersion: SCHEMA_VERSION
      };
      if (idx >= 0) all[idx] = clean;
      else all.push(clean);
      backend.writeAll(all);
      return clean;
    }

    function remove(id) {
      const all = backend.readAll().filter(s => s.id !== id);
      return backend.writeAll(all);
    }

    return { list, get, save, remove, existsByName };
  })();

  // --- First-launch seeding ---
  // Pre-populates default sessions on the very first launch of the app on this
  // device. A persistent flag prevents re-seeding — so if the user later deletes
  // a seeded session, it stays deleted.
  const DEFAULT_SESSIONS = [
    {
      name: 'Shambhavi Mahamudra',
      intervals: [
        { name: 'Invocation Prayer',  seconds: 30 },
        { name: 'Sukha Kriya',        seconds: 360 },
        { name: 'AUM Chanting',       seconds: 360 },
        { name: 'Flutter Breathing',  seconds: 180 },
        { name: 'Bandhas',            seconds: 60 },
        { name: 'Watching the breath', seconds: 300 }
      ]
    }
  ];

  function seedDefaultSessions() {
    const SEED_FLAG = 'med_seeded_v1';
    if (localStorage.getItem(SEED_FLAG)) return;
    try {
      DEFAULT_SESSIONS.forEach(s => {
        if (!SessionStore.existsByName(s.name)) {
          SessionStore.save(s);
        }
      });
      localStorage.setItem(SEED_FLAG, '1');
    } catch (e) { console.warn('Seeding failed:', e); }
  }

  // --- Audio ---
  function getAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  async function loadChimes() {
    const ctx = getAudio();
    const entries = Object.entries(chimeFiles);
    await Promise.all(entries.map(async ([key, url]) => {
      try {
        const res = await fetch(url);
        const arr = await res.arrayBuffer();
        audioBuffers[key] = await ctx.decodeAudioData(arr);
      } catch (e) {
        console.warn('Failed to load ' + key + ':', e);
      }
    }));
  }

  // Silent audio keeps the AudioContext alive longer when the tab backgrounds
  // on mobile browsers. Not a guarantee — iOS Safari will still suspend
  // background tabs eventually, but it buys us the short locks / app switches.
  function startSilentAudio() {
    const ctx = getAudio();
    if (silentSource) return;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    silentSource = ctx.createBufferSource();
    silentSource.buffer = buffer;
    silentSource.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0.001;
    silentSource.connect(gain).connect(ctx.destination);
    silentSource.start();
  }

  function stopSilentAudio() {
    if (silentSource) {
      try { silentSource.stop(); } catch (e) {}
      silentSource = null;
    }
  }

  function playChime() {
    const ctx = getAudio();
    const type = $('chime-type').value;
    const vol = parseInt($('volume').value, 10) / 100;
    const buffer = audioBuffers[type];

    if (buffer) {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = vol;
      source.connect(gain).connect(ctx.destination);
      source.start(0);
    } else {
      playSynthChime(type, vol);
    }

    // Vibration API — works on Android; iOS Safari ignores it
    if (navigator.vibrate) {
      try { navigator.vibrate(50); } catch (e) {}
    }
  }

  function playSynthChime(type, vol) {
    const ctx = getAudio();
    const now = ctx.currentTime;
    const configs = {
      bell: { freqs: [880, 1760, 2640], decay: 2.5, wave: 'sine' },
      bowl: { freqs: [220, 440, 660, 880], decay: 4.0, wave: 'sine' },
      gong: { freqs: [110, 165, 220, 330], decay: 3.5, wave: 'triangle' },
      wood: { freqs: [800], decay: 0.15, wave: 'square' }
    };
    const cfg = configs[type] || configs.bell;
    cfg.freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = cfg.wave;
      osc.frequency.value = f;
      const amp = vol * (1 / (i + 1)) * 0.3;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(amp, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + cfg.decay);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + cfg.decay);
    });
  }

  // --- Wake Lock (replaces KeepAwake plugin) ---
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) {
      console.warn('Wake Lock request failed:', e);
    }
  }

  async function releaseWakeLock() {
    if (wakeLock) {
      try { await wakeLock.release(); } catch (e) {}
      wakeLock = null;
    }
  }

  // Re-acquire wake lock when the tab becomes visible again (iOS drops it on blur)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && timer && !paused && $('keep-awake').checked) {
      requestWakeLock();
    }
  });

  // --- Media Session (lock-screen metadata while audio plays) ---
  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: intervals[currentIdx] ? intervals[currentIdx].name : 'Meditation',
      artist: 'Meditation Timer',
      album: 'Interval ' + (currentIdx + 1) + ' of ' + intervals.length
    });
    try {
      navigator.mediaSession.setActionHandler('play', () => { if (paused) togglePause(); });
      navigator.mediaSession.setActionHandler('pause', () => { if (!paused) togglePause(); });
      navigator.mediaSession.setActionHandler('nexttrack', skipInterval);
      navigator.mediaSession.setActionHandler('stop', stopSession);
    } catch (e) {}
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !intervals[currentIdx]) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: intervals[currentIdx].name,
      artist: 'Meditation Timer',
      album: 'Interval ' + (currentIdx + 1) + ' of ' + intervals.length
    });
    navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
  }

  function clearMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = 'none';
    ['play', 'pause', 'nexttrack', 'stop'].forEach(a => {
      try { navigator.mediaSession.setActionHandler(a, null); } catch (e) {}
    });
  }

  // --- Intervals UI ---
  function renderIntervals() {
    const list = $('intervals-list');
    list.innerHTML = '';
    intervals.forEach((iv, i) => {
      const row = document.createElement('div');
      row.className = 'interval-row';
      row.innerHTML = '\n        <span class="idx">' + (i + 1) + '</span>\n        <input type="text" value="' + escapeHtml(iv.name) + '" data-idx="' + i + '" data-field="name" />\n        <input type="number" value="' + Math.floor(iv.seconds / 60) + '" min="0" max="120" data-idx="' + i + '" data-field="min" />\n        <span class="unit">m</span>\n        <input type="number" value="' + (iv.seconds % 60) + '" min="0" max="59" data-idx="' + i + '" data-field="sec" />\n        <span class="unit">s</span>\n        <button class="remove" data-remove="' + i + '" aria-label="Remove">×</button>\n      ';
      list.appendChild(row);
    });
    list.querySelectorAll('input').forEach(inp => inp.addEventListener('change', handleIntervalChange));
    list.querySelectorAll('button[data-remove]').forEach(btn => btn.addEventListener('click', handleIntervalRemove));
    updateTotal();
  }

  function handleIntervalChange(e) {
    const list = $('intervals-list');
    const i = parseInt(e.target.dataset.idx, 10);
    const field = e.target.dataset.field;
    if (field === 'name') {
      intervals[i].name = e.target.value || 'Untitled';
    } else {
      const min = parseInt(list.querySelector('input[data-idx="' + i + '"][data-field="min"]').value, 10) || 0;
      const sec = parseInt(list.querySelector('input[data-idx="' + i + '"][data-field="sec"]').value, 10) || 0;
      intervals[i].seconds = Math.max(1, min * 60 + sec);
    }
    markDirty();
    updateTotal();
    saveState();
  }

  function handleIntervalRemove(e) {
    const i = parseInt(e.target.dataset.remove, 10);
    if (intervals.length > 1) {
      intervals.splice(i, 1);
      markDirty();
      renderIntervals();
      saveState();
    }
  }

  function updateTotal() {
    $('total-time').textContent = 'Total: ' + fmt(totalSeconds());
  }

  // --- Session library UI ---
  function updateHeader() {
    const title = $('current-session-title');
    const subtitle = $('session-subtitle');
    const saveBtn = $('save-session-btn');

    if (currentSessionName) {
      title.textContent = currentSessionName + (isDirty ? ' •' : '');
      subtitle.textContent = isDirty ? 'Unsaved changes' : 'Peace begins with pause';
    } else {
      title.textContent = 'Intervals';
      subtitle.textContent = 'Build your session';
    }

    saveBtn.disabled = !(currentSessionId && isDirty);
    saveBtn.classList.toggle('dirty', currentSessionId && isDirty);
  }

  function markDirty() {
    if (currentSessionId) {
      isDirty = true;
      updateHeader();
    }
  }

  function renderSessions() {
    const list = $('sessions-list');
    const empty = $('sessions-empty');
    const sessions = SessionStore.list();

    list.innerHTML = '';
    if (sessions.length === 0) {
      empty.classList.remove('hidden');
      list.classList.add('hidden');
      return;
    }
    empty.classList.add('hidden');
    list.classList.remove('hidden');

    sessions.forEach(s => {
      const item = document.createElement('div');
      item.className = 'session-item' + (s.id === currentSessionId ? ' active' : '');
      item.dataset.id = s.id;
      const totalSec = s.intervals.reduce((a, b) => a + b.seconds, 0);
      item.innerHTML = '\n        <div class="session-info">\n          <div class="session-name">' + escapeHtml(s.name) + '</div>\n          <div class="session-meta">' + s.intervals.length + ' interval' + (s.intervals.length === 1 ? '' : 's') + ' · ' + fmt(totalSec) + ' · ' + formatDate(s.updatedAt) + '</div>\n        </div>\n        <button class="session-delete" data-delete="' + s.id + '" aria-label="Delete session">×</button>\n      ';
      item.addEventListener('click', e => {
        if (e.target.closest('.session-delete')) return;
        loadSession(s.id);
      });
      list.appendChild(item);
    });

    list.querySelectorAll('.session-delete').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        handleDeleteSession(e.currentTarget.dataset.delete);
      });
    });
  }

  function loadSession(id) {
    const s = SessionStore.get(id);
    if (!s) return;
    if (isDirty && currentSessionId && !confirm('Discard unsaved changes to "' + currentSessionName + '"?')) {
      return;
    }
    intervals = s.intervals.map(iv => ({ name: iv.name, seconds: iv.seconds }));
    currentSessionId = s.id;
    currentSessionName = s.name;
    isDirty = false;
    if (s.chime && $('chime-type').querySelector('option[value="' + s.chime + '"]')) {
      $('chime-type').value = s.chime;
    }
    renderIntervals();
    renderSessions();
    updateHeader();
    saveState();
  }

  function newSession() {
    if (isDirty && currentSessionId && !confirm('Discard unsaved changes to "' + currentSessionName + '"?')) {
      return;
    }
    intervals = JSON.parse(JSON.stringify(DEFAULT_INTERVALS));
    currentSessionId = null;
    currentSessionName = null;
    isDirty = false;
    renderIntervals();
    renderSessions();
    updateHeader();
    saveState();
  }

  function handleDeleteSession(id) {
    const s = SessionStore.get(id);
    if (!s) return;
    if (!confirm('Delete "' + s.name + '"? This cannot be undone.')) return;
    SessionStore.remove(id);
    if (currentSessionId === id) {
      currentSessionId = null;
      currentSessionName = null;
      isDirty = false;
    }
    renderSessions();
    updateHeader();
    saveState();
  }

  function saveCurrent() {
    if (!currentSessionId) { promptSaveAs(); return; }
    const saved = SessionStore.save({
      id: currentSessionId,
      name: currentSessionName,
      intervals: intervals,
      chime: $('chime-type').value
    });
    currentSessionId = saved.id;
    currentSessionName = saved.name;
    isDirty = false;
    renderSessions();
    updateHeader();
    saveState();
  }

  function promptSaveAs() {
    openNameModal(currentSessionName || '', (name) => {
      const saved = SessionStore.save({
        id: null,
        name: name,
        intervals: intervals,
        chime: $('chime-type').value
      });
      currentSessionId = saved.id;
      currentSessionName = saved.name;
      isDirty = false;
      renderSessions();
      updateHeader();
      saveState();
    });
  }

  // --- Name modal ---
  let modalConfirmCb = null;

  function openNameModal(initial, onConfirm) {
    const modal = $('name-modal');
    const input = $('name-modal-input');
    const err = $('name-modal-error');
    input.value = initial || '';
    err.textContent = '';
    modalConfirmCb = onConfirm;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => input.focus(), 50);
  }

  function closeNameModal() {
    const modal = $('name-modal');
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    modalConfirmCb = null;
  }

  function confirmNameModal() {
    const input = $('name-modal-input');
    const err = $('name-modal-error');
    const name = (input.value || '').trim();
    if (!name) { err.textContent = 'Please enter a name.'; return; }
    if (name.length > 60) { err.textContent = 'Name is too long (max 60).'; return; }
    if (SessionStore.existsByName(name, currentSessionId)) {
      err.textContent = 'A session with that name already exists.';
      return;
    }
    const cb = modalConfirmCb;
    closeNameModal();
    if (cb) cb(name);
  }

  // --- Persistence (working draft + settings) ---
  function saveState() {
    try {
      localStorage.setItem('med_intervals', JSON.stringify(intervals));
      localStorage.setItem('med_current_session', JSON.stringify({
        id: currentSessionId,
        name: currentSessionName
      }));
      localStorage.setItem('med_settings', JSON.stringify({
        chime: $('chime-type').value,
        volume: $('volume').value,
        startChime: $('start-chime').checked,
        keepAwake: $('keep-awake').checked
      }));
    } catch (e) {}
  }

  function loadState() {
    try {
      const saved = localStorage.getItem('med_intervals');
      if (saved) intervals = JSON.parse(saved);
      const current = JSON.parse(localStorage.getItem('med_current_session') || 'null');
      if (current && current.id && SessionStore.get(current.id)) {
        currentSessionId = current.id;
        currentSessionName = current.name;
      }
      const settings = JSON.parse(localStorage.getItem('med_settings') || '{}');
      if (settings.chime) $('chime-type').value = settings.chime;
      if (settings.volume) {
        $('volume').value = settings.volume;
        $('volume-val').textContent = settings.volume;
      }
      if (typeof settings.startChime === 'boolean') $('start-chime').checked = settings.startChime;
      if (typeof settings.keepAwake === 'boolean') $('keep-awake').checked = settings.keepAwake;
    } catch (e) {}
  }

  // --- Session flow ---
  function showView(name) {
    ['setup-view', 'run-view', 'done-view'].forEach(v => {
      $(v).classList.toggle('active', v === name + '-view');
    });
  }

  async function startSession() {
    if (totalSeconds() === 0) return;
    getAudio();
    startSilentAudio();
    sessionStartMs = Date.now();

    if ($('keep-awake').checked) {
      await requestWakeLock();
    }

    setupMediaSession();

    showView('run');
    currentIdx = 0;
    paused = false;
    $('pause-btn').textContent = 'Pause';
    startInterval(true);
  }

  function startInterval(isFirst) {
    if (currentIdx >= intervals.length) { endSession(); return; }
    remaining = intervals[currentIdx].seconds;
    $('phase-label').textContent = 'Interval ' + (currentIdx + 1) + ' of ' + intervals.length;
    $('phase-name').textContent = intervals[currentIdx].name;

    const next = intervals[currentIdx + 1];
    $('upcoming').textContent = next
      ? 'Next: ' + next.name + ' (' + fmt(next.seconds) + ')'
      : 'Last interval';

    const shouldChime = isFirst ? $('start-chime').checked : true;
    if (shouldChime) playChime();

    updateDisplay();
    updateMediaSession();
    if (timer) clearInterval(timer);
    timer = setInterval(tick, 1000);
  }

  function tick() {
    if (paused) return;
    remaining--;
    if (remaining <= 0) {
      currentIdx++;
      if (currentIdx >= intervals.length) {
        playChime();
        clearInterval(timer);
        setTimeout(endSession, 600);
        return;
      }
      startInterval(false);
      return;
    }
    updateDisplay();
    if (remaining % 10 === 0) updateMediaSession();
  }

  function updateDisplay() {
    $('time-display').textContent = fmt(remaining);
    const total = intervals[currentIdx].seconds;
    const pct = 1 - (remaining / total);
    $('progress-ring').setAttribute('stroke-dashoffset', String(628.3 * (1 - pct)));
    const totalLeft = remaining + intervals.slice(currentIdx + 1).reduce((a, b) => a + b.seconds, 0);
    $('total-remaining').textContent = fmt(totalLeft) + ' total left';
  }

  function togglePause() {
    paused = !paused;
    $('pause-btn').textContent = paused ? 'Resume' : 'Pause';
    updateMediaSession();
    if (paused) {
      releaseWakeLock();
    } else if ($('keep-awake').checked) {
      requestWakeLock();
    }
  }

  function skipInterval() {
    currentIdx++;
    if (currentIdx >= intervals.length) { clearInterval(timer); endSession(); }
    else startInterval(false);
  }

  async function endSession() {
    clearInterval(timer);
    stopSilentAudio();
    await releaseWakeLock();
    clearMediaSession();
    $('done-summary').textContent = 'You meditated for ' + fmt(totalSeconds());
    showView('done');
  }

  async function stopSession() {
    clearInterval(timer);
    stopSilentAudio();
    await releaseWakeLock();
    clearMediaSession();
    showView('setup');
  }

  // --- Presets ---
  const presets = {
    breath: [
      { name: 'Arrive', seconds: 30 },
      { name: 'Breath focus', seconds: 120 },
      { name: 'Release', seconds: 30 }
    ],
    body: [
      { name: 'Settle', seconds: 60 },
      { name: 'Body scan', seconds: 480 },
      { name: 'Integrate', seconds: 60 }
    ],
    deep: [
      { name: 'Arrive', seconds: 120 },
      { name: 'Anchor to breath', seconds: 300 },
      { name: 'Open awareness', seconds: 600 },
      { name: 'Closing', seconds: 180 }
    ]
  };

  // --- Event wiring ---
  function wire() {
    $('add-interval').addEventListener('click', () => {
      intervals.push({ name: 'New interval', seconds: 180 });
      markDirty();
      renderIntervals();
      saveState();
    });

    document.querySelectorAll('.preset').forEach(btn => {
      btn.addEventListener('click', e => {
        const key = e.target.dataset.preset;
        if (presets[key]) {
          if (isDirty && currentSessionId && !confirm('Discard unsaved changes to "' + currentSessionName + '"?')) {
            return;
          }
          intervals = JSON.parse(JSON.stringify(presets[key]));
          currentSessionId = null;
          currentSessionName = null;
          isDirty = false;
          renderIntervals();
          renderSessions();
          updateHeader();
          saveState();
        }
      });
    });

    $('start-btn').addEventListener('click', startSession);
    $('pause-btn').addEventListener('click', togglePause);
    $('skip-btn').addEventListener('click', skipInterval);
    $('stop-btn').addEventListener('click', stopSession);
    $('reset-btn').addEventListener('click', () => showView('setup'));

    $('new-session-btn').addEventListener('click', newSession);
    $('save-session-btn').addEventListener('click', saveCurrent);
    $('save-as-btn').addEventListener('click', promptSaveAs);

    $('name-modal-save').addEventListener('click', confirmNameModal);
    $('name-modal-cancel').addEventListener('click', closeNameModal);
    $('name-modal').querySelector('.modal-backdrop').addEventListener('click', closeNameModal);
    $('name-modal-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); confirmNameModal(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeNameModal(); }
    });

    $('test-chime').addEventListener('click', () => {
      getAudio();
      playChime();
    });

    $('chime-type').addEventListener('change', saveState);
    $('volume').addEventListener('input', e => {
      $('volume-val').textContent = e.target.value;
    });
    $('volume').addEventListener('change', saveState);
    $('start-chime').addEventListener('change', saveState);
    $('keep-awake').addEventListener('change', saveState);
  }

  // --- Init ---
  document.addEventListener('DOMContentLoaded', async () => {
    wire();
    seedDefaultSessions();
    loadState();
    renderIntervals();
    renderSessions();
    updateHeader();

    try { await loadChimes(); } catch (e) { console.warn('Audio preload failed', e); }
  });
})();
