/* Spindle: a Spotify web client with a Spicetify-style Marketplace.
   Playback uses the official Web API (Spotify Connect remote control) and optionally the Web Playback SDK.
   Extensions run in sandboxed iframes and talk to the page through a small Spicetify shim. */
'use strict';

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem('sw.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sw.' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  del(k) { try { localStorage.removeItem('sw.' + k); } catch { /* ignore */ } },
};
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return e;
}
const ICONS = {
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  store: '<path d="M4 8h16l-1 12H5zM8 8V6a4 4 0 018 0v2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
  pause: '<path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/>',
  next: '<path d="M5 4l10 8-10 8zM17 4h2v16h-2z" fill="currentColor"/>',
  prev: '<path d="M19 4L9 12l10 8zM5 4h2v16H5z" fill="currentColor"/>',
  shuffle: '<path d="M3 6h4l10 12h4M3 18h4l3-3.6M14 9.6L17 6h4M18 3l3 3-3 3M18 15l3 3-3 3"/>',
  repeat: '<path d="M4 11V9a3 3 0 013-3h13M17 3l3 3-3 3M20 13v2a3 3 0 01-3 3H4M7 21l-3-3 3-3"/>',
  device: '<rect x="3" y="4" width="14" height="11" rx="1"/><path d="M8 19h4M10 15v4"/><rect x="18" y="8" width="3" height="11" rx="1"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
};
function ic(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICONS[name]; // static strings only
  return s;
}
function toast(msg, isErr) {
  const t = h('div', { class: 'toast' + (isErr ? ' err' : '') }, String(msg));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), isErr ? 5000 : 2600);
}
const fmt = ms => { ms = Math.max(0, ms | 0); const s = Math.round(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const img = (images, cls = 'cover') => h('img', { class: cls, src: (images && (images[images.length > 1 ? 1 : 0] || {}).url) || '', alt: '', loading: 'lazy' });
const artists = t => (t.artists || []).map(a => a.name).join(', ');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ---------- auth (PKCE, no server) ---------- */
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative user-library-read streaming user-read-email user-read-private';
const redirectUri = location.origin + location.pathname;
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function login() {
  const id = LS.get('clientId');
  if (!id) { location.hash = '#/settings'; toast('Add your Spotify Client ID first.', true); return; }
  const verifier = b64(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64(crypto.getRandomValues(new Uint8Array(12)));
  LS.set('verifier', verifier); LS.set('state', state);
  location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: id, response_type: 'code', redirect_uri: redirectUri, code_challenge_method: 'S256',
    code_challenge: challenge, scope: SCOPES, state,
  });
}
async function tokenReq(body) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: LS.get('clientId'), ...body }),
  });
  if (!r.ok) throw new Error('Spotify login failed (' + r.status + '). Check the Client ID and redirect URI.');
  const j = await r.json();
  LS.set('tok', { access: j.access_token, refresh: j.refresh_token || (LS.get('tok') || {}).refresh, exp: Date.now() + j.expires_in * 1000 - 30000 });
}
async function handleCallback() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return;
  const code = p.get('code'), state = p.get('state');
  history.replaceState({}, '', location.pathname + location.hash);
  if (p.get('error')) throw new Error('Spotify said: ' + p.get('error'));
  if (state !== LS.get('state')) throw new Error('Login state did not match. Try signing in again.');
  await tokenReq({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: LS.get('verifier') });
}
async function token() {
  const t = LS.get('tok');
  if (!t) return null;
  if (Date.now() < t.exp) return t.access;
  await tokenReq({ grant_type: 'refresh_token', refresh_token: t.refresh });
  return LS.get('tok').access;
}
function logout() { LS.del('tok'); location.hash = '#/home'; location.reload(); }

async function api(path, { method = 'GET', body, query, retry = true } = {}) {
  const tok = await token();
  if (!tok) throw new Error('Not signed in');
  const url = new URL(path.startsWith('http') ? path : 'https://api.spotify.com/v1' + path);
  for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, v);
  const r = await fetch(url, {
    method, headers: { Authorization: 'Bearer ' + tok, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 429 && retry) {
    await new Promise(res => setTimeout(res, (+r.headers.get('Retry-After') || 1) * 1000));
    return api(path, { method, body, query, retry: false });
  }
  if (r.status === 204 || r.status === 202) return null;
  const txt = await r.text();
  let j = null; try { j = txt ? JSON.parse(txt) : null; } catch { /* not json */ }
  if (!r.ok) {
    const e = new Error((j && j.error && (j.error.message || j.error)) || ('HTTP ' + r.status));
    e.status = r.status; e.reason = j && j.error && j.error.reason; throw e;
  }
  return j;
}

/* ---------- player state ---------- */
const P = { s: null, ts: 0, sdkId: null, sdk: null };
const listeners = new Set();
const onState = fn => listeners.add(fn);
let lastUri = null, lastPlaying = null;

function progressNow() {
  const s = P.s; if (!s || !s.item) return 0;
  return Math.min(s.item.duration_ms, s.progress_ms + (s.is_playing ? Date.now() - P.ts : 0));
}
function applyState(s) {
  P.s = s && s.item ? s : (s || null); P.ts = Date.now();
  const uri = s && s.item ? s.item.uri : null, playing = !!(s && s.is_playing);
  const songChanged = uri !== lastUri, ppChanged = playing !== lastPlaying;
  lastUri = uri; lastPlaying = playing;
  listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } });
  if (songChanged) Ext.emit('songchange');
  if (ppChanged) Ext.emit('onplaypause');
}
async function poll() {
  if (document.hidden || !LS.get('tok')) return;
  try { applyState(await api('/me/player', { query: { additional_types: 'track,episode' } })); } catch (e) { if (e.status === 401) logout(); }
}
async function act(fn) {
  try { await fn(); setTimeout(poll, 350); }
  catch (e) {
    if (e.status === 404 || e.reason === 'NO_ACTIVE_DEVICE') { toast('No active device. Pick one.', true); openDevices(); }
    else if (e.status === 403) toast(e.message || 'Spotify Premium is needed to control playback.', true);
    else toast(e.message, true);
  }
}
const Cmd = {
  play: (body = {}) => act(() => api('/me/player/play', { method: 'PUT', body, query: P.s ? {} : (P.sdkId ? { device_id: P.sdkId } : {}) })),
  pause: () => act(() => api('/me/player/pause', { method: 'PUT' })),
  toggle: () => (P.s && P.s.is_playing ? Cmd.pause() : Cmd.play()),
  next: () => act(() => api('/me/player/next', { method: 'POST' })),
  prev: () => act(() => api('/me/player/previous', { method: 'POST' })),
  seek: ms => act(() => api('/me/player/seek', { method: 'PUT', query: { position_ms: Math.round(ms) } })),
  volume: v => act(() => api('/me/player/volume', { method: 'PUT', query: { volume_percent: Math.round(v) } })),
  shuffle: () => act(() => api('/me/player/shuffle', { method: 'PUT', query: { state: !(P.s && P.s.shuffle_state) } })),
  repeat: () => act(() => api('/me/player/repeat', { method: 'PUT', query: { state: (P.s && P.s.repeat_state) === 'off' ? 'context' : 'off' } })),
  queue: uri => act(() => api('/me/player/queue', { method: 'POST', query: { uri } })),
  transfer: id => act(() => api('/me/player', { method: 'PUT', body: { device_ids: [id], play: true } })),
};

/* ---------- Web Playback SDK (optional, desktop browsers) ---------- */
function enableSdk() {
  if (P.sdk || document.getElementById('sdk')) return;
  window.onSpotifyWebPlaybackSDKReady = () => {
    const p = new Spotify.Player({ name: 'Spindle (this browser)', getOAuthToken: async cb => cb(await token()), volume: 0.8 });
    p.addListener('ready', ({ device_id }) => { P.sdkId = device_id; toast('This browser is now a Spotify device.'); });
    p.addListener('initialization_error', e => toast(e.message, true));
    p.addListener('authentication_error', e => toast(e.message, true));
    p.addListener('account_error', () => toast('Browser playback needs Spotify Premium.', true));
    p.addListener('player_state_changed', () => setTimeout(poll, 200));
    p.connect(); P.sdk = p;
  };
  document.head.append(h('script', { id: 'sdk', src: 'https://sdk.scdn.co/spotify-player.js' }));
}

/* ---------- now-playing bar, sheet, devices ---------- */
function renderBar() {
  const bar = $('#bar'), s = P.s;
  if (!LS.get('tok')) { bar.hidden = true; return; }
  bar.hidden = false;
  if (!s || !s.item) {
    bar.replaceChildren(h('div', { class: 'meta' }, h('div', { class: 't1' }, 'Nothing playing'), h('div', { class: 't2' }, 'Pick a device, then press play')),
      h('button', { class: 'iconbtn', 'aria-label': 'Devices', onclick: openDevices }, ic('device')));
    return;
  }
  const it = s.item;
  bar.replaceChildren(
    h('button', { class: 'row', style: 'flex:1;padding:0;min-width:0', onclick: openSheet, 'aria-label': 'Open player' },
      img((it.album || it.show || {}).images), h('div', { class: 'meta' }, h('div', { class: 't1' }, it.name), h('div', { class: 't2' }, it.artists ? artists(it) : (it.show || {}).name || ''))),
    h('button', { class: 'iconbtn', 'aria-label': 'Devices', onclick: openDevices }, ic('device')),
    h('button', { class: 'iconbtn playbtn', 'aria-label': s.is_playing ? 'Pause' : 'Play', onclick: Cmd.toggle }, ic(s.is_playing ? 'pause' : 'play')),
    h('div', { class: 'prog', id: 'barprog' }));
}
function tickProgress() {
  const s = P.s; if (!s || !s.item) return;
  const p = progressNow(), pct = (p / s.item.duration_ms) * 100 + '%';
  const bp = $('#barprog'); if (bp) bp.style.width = pct;
  const sk = $('#seek'); if (sk && !sk.dataset.drag) { sk.value = p; }
  const tc = $('#tcur'); if (tc) tc.textContent = fmt(p);
}
let sheetOpen = false;
function openSheet() { sheetOpen = true; $('#sheet').hidden = false; renderSheet(); }
function closeSheet() { sheetOpen = false; $('#sheet').hidden = true; }
function renderSheet() {
  if (!sheetOpen) return;
  const s = P.s, el = $('#sheet');
  if (!s || !s.item) { closeSheet(); return; }
  const it = s.item, seek = h('input', { type: 'range', id: 'seek', min: 0, max: it.duration_ms, value: progressNow(), 'aria-label': 'Seek' });
  seek.addEventListener('input', () => { seek.dataset.drag = 1; $('#tcur').textContent = fmt(+seek.value); });
  seek.addEventListener('change', () => { delete seek.dataset.drag; Cmd.seek(+seek.value); });
  const vol = h('input', { type: 'range', min: 0, max: 100, value: (s.device && s.device.volume_percent) ?? 50, 'aria-label': 'Volume' });
  vol.addEventListener('change', () => Cmd.volume(+vol.value));
  el.replaceChildren(
    h('div', { class: 'top' }, h('button', { class: 'iconbtn', 'aria-label': 'Close player', onclick: closeSheet }, ic('down')), h('button', { class: 'iconbtn', 'aria-label': 'Devices', onclick: openDevices }, ic('device'))),
    img((it.album || it.show || {}).images && (it.album || it.show).images.slice().reverse(), 'big'),
    h('div', { class: 'info' }, h('div', { class: 't1' }, it.name), h('div', { class: 't2' }, it.artists ? artists(it) : (it.show || {}).name || '')),
    h('div', { class: 'seek' }, seek, h('div', { class: 'times' }, h('span', { id: 'tcur' }, fmt(progressNow())), h('span', {}, fmt(it.duration_ms)))),
    h('div', { class: 'ctrls' },
      h('button', { class: 'iconbtn' + (s.shuffle_state ? ' on' : ''), 'aria-label': 'Shuffle', 'aria-pressed': !!s.shuffle_state, onclick: Cmd.shuffle }, ic('shuffle')),
      h('button', { class: 'iconbtn', 'aria-label': 'Previous', onclick: Cmd.prev }, ic('prev')),
      h('button', { class: 'iconbtn playbtn', 'aria-label': s.is_playing ? 'Pause' : 'Play', onclick: Cmd.toggle }, ic(s.is_playing ? 'pause' : 'play')),
      h('button', { class: 'iconbtn', 'aria-label': 'Next', onclick: Cmd.next }, ic('next')),
      h('button', { class: 'iconbtn' + (s.repeat_state !== 'off' ? ' on' : ''), 'aria-label': 'Repeat', 'aria-pressed': s.repeat_state !== 'off', onclick: Cmd.repeat }, ic('repeat'))),
    h('div', { class: 'vol' }, h('span', { class: 'small' }, 'Vol'), vol),
    h('div', { class: 'top', style: 'justify-content:center;gap:.5rem;flex-wrap:wrap' }, ...Ext.actions.filter(a => a.kind === 'topbar').map(Ext.actionBtn)));
}
async function openDevices() {
  const pop = $('#devices'); pop.hidden = false;
  const card = h('div', { class: 'card' }, h('h2', {}, 'Play on'), h('div', { class: 'muted' }, 'Looking for devices…'));
  pop.replaceChildren(card);
  pop.onclick = e => { if (e.target === pop) pop.hidden = true; };
  try {
    const { devices } = await api('/me/player/devices');
    card.replaceChildren(h('h2', {}, 'Play on'),
      devices.length ? devices.map(d => h('button', { class: 'row', onclick: () => { pop.hidden = true; Cmd.transfer(d.id); } },
        h('div', { class: 'meta' }, h('div', { class: 't1' }, d.name + (d.is_active ? ' (active)' : '')), h('div', { class: 't2' }, d.type)))) :
        h('p', { class: 'muted' }, 'No devices found. Open the Spotify app on your phone and start any song once, then try again.'),
      h('button', { class: 'btn ghost', onclick: () => { pop.hidden = true; } }, 'Close'));
  } catch (e) { card.replaceChildren(h('h2', {}, 'Play on'), h('p', { class: 'err' }, e.message), h('button', { class: 'btn ghost', onclick: () => { pop.hidden = true; } }, 'Close')); }
}

/* ---------- views ---------- */
const view = $('#view');
const NAV = [['home', 'Library', 'home'], ['search', 'Search', 'search'], ['market', 'Marketplace', 'store'], ['settings', 'Settings', 'gear']];
function renderNav(route) {
  $('#nav').replaceChildren(...NAV.map(([id, label, icon]) => {
    const a = h('a', { href: '#/' + id }, ic(icon), label);
    if (route === id) a.setAttribute('aria-current', 'page');
    return a;
  }));
}
function playRow(t, onclick, idx) {
  const cur = P.s && P.s.item && P.s.item.uri === t.uri;
  return h('button', { class: 'row' + (cur ? ' now' : ''), onclick },
    img((t.album || {}).images), h('div', { class: 'meta' }, h('div', { class: 't1' }, t.name), h('div', { class: 't2' }, artists(t))), h('span', { class: 'dur' }, fmt(t.duration_ms)));
}
const errBox = e => h('p', { class: 'err' }, e.message + (e.status === 403 ? ' (Spotify may restrict this endpoint for apps in development mode.)' : ''));

function signInView() {
  const has = !!LS.get('clientId');
  view.replaceChildren(h('div', { class: 'hero' },
    h('h1', {}, 'Spindle'),
    h('p', { class: 'muted' }, 'Your Spotify library, with a Marketplace for Spicetify-style extensions and color schemes. Playback controls the Spotify app on your phone through Spotify Connect.'),
    has ? h('button', { class: 'btn', onclick: login }, 'Sign in with Spotify') : h('a', { class: 'btn', href: '#/settings', style: 'text-decoration:none;display:inline-block' }, 'Set up Spotify access'),
    h('p', { class: 'small muted' }, 'You need a free developer app at developer.spotify.com and Spotify Premium for playback control. Setup takes a few minutes.')));
}

async function homeView() {
  const tab = LS.get('libtab', 'playlists');
  const tabs = h('div', { class: 'tabs' }, ...[['playlists', 'Playlists'], ['liked', 'Liked songs']].map(([id, l]) =>
    h('button', { class: 'chip', 'aria-pressed': tab === id, onclick: () => { LS.set('libtab', id); route(); } }, l)));
  const box = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  view.replaceChildren(h('div', { class: 'head' }, h('h1', {}, 'Library')), tabs, box);
  try {
    if (tab === 'playlists') {
      const j = await api('/me/playlists', { query: { limit: 50 } });
      P.playlists = Object.fromEntries(j.items.filter(Boolean).map(p => [p.id, p]));
      box.replaceChildren(h('div', { class: 'grid' }, j.items.filter(Boolean).map(p =>
        h('a', { class: 'tile', href: '#/playlist/' + p.id, style: 'color:inherit;text-decoration:none' }, img(p.images, 'ph'), h('div', { class: 't1' }, p.name), h('div', { class: 't2' }, (p.owner || {}).display_name || '')))));
    } else {
      const items = []; const list = h('div', { class: 'list' });
      const more = h('button', { class: 'btn ghost' }, 'Load more');
      let offset = 0;
      const load = async () => {
        const j = await api('/me/tracks', { query: { limit: 50, offset } });
        offset += j.items.length;
        j.items.forEach(x => items.push(x.track));
        list.replaceChildren(...items.map((t, i) => playRow(t, () => Cmd.play({ uris: items.slice(i, i + 50).map(x => x.uri) }))));
        more.hidden = !j.next;
      };
      more.onclick = () => load().catch(e => toast(e.message, true));
      box.replaceChildren(list, more); await load();
    }
  } catch (e) { box.replaceChildren(errBox(e)); }
}

async function playlistView(id) {
  const box = h('div', { class: 'list' }), more = h('button', { class: 'btn ghost' }, 'Load more');
  const title = h('h1', {}, (P.playlists && P.playlists[id] ? P.playlists[id].name : 'Playlist'));
  view.replaceChildren(h('div', { class: 'head' }, title, h('button', { class: 'btn', onclick: () => Cmd.play({ context_uri: 'spotify:playlist:' + id }) }, 'Play')), box, more);
  const items = []; let offset = 0;
  const load = async () => {
    let j;
    try { j = await api(`/playlists/${id}/items`, { query: { limit: 100, offset, additional_types: 'track' } }); }
    catch (e) { if (e.status === 404) j = await api(`/playlists/${id}/tracks`, { query: { limit: 100, offset } }); else throw e; }
    offset += j.items.length;
    j.items.map(x => x.item || x.track).filter(t => t && t.uri && t.type !== 'episode').forEach(t => items.push(t));
    box.replaceChildren(...items.map(t => playRow(t, () => Cmd.play({ context_uri: 'spotify:playlist:' + id, offset: { uri: t.uri } }))));
    more.hidden = !j.next;
  };
  more.onclick = () => load().catch(e => toast(e.message, true));
  try { await load(); } catch (e) { box.replaceChildren(errBox(e)); more.hidden = true; }
}

function searchView() {
  const out = h('div', { class: 'list' });
  const input = h('input', { type: 'search', id: 'q', placeholder: 'Songs, albums, playlists', value: LS.get('lastq', ''), autocomplete: 'off', 'aria-label': 'Search' });
  const run = async () => {
    const q = input.value.trim(); LS.set('lastq', q);
    if (!q) { out.replaceChildren(); return; }
    try {
      // Catalog search is served by the SpotAPI-backed local service. Playback remains
      // on Spotify's supported Web API because SpotAPI is a Python library, not a browser SDK.
      const apiBase = String(window.SPOTAPI_API_BASE || '').replace(/\/$/, '');
      if (!apiBase) throw new Error('SpotAPI backend is not configured. Set SPOTAPI_API_BASE in config.js and deploy the Python backend; GitHub Pages cannot run Python itself.');
      const r = await fetch(apiBase + '/api/search?q=' + encodeURIComponent(q));
      if (!r.ok) throw new Error('SpotAPI search failed (' + r.status + '). Check that the backend is deployed and healthy.');
      const j = await r.json();
      const sec = (title, arr, row) => arr && arr.items && arr.items.filter(Boolean).length ? [h('h2', { style: 'margin-top:.8rem' }, title), ...arr.items.filter(Boolean).map(row)] : [];
      const tr = (j.tracks || {}).items ? j.tracks.items.filter(Boolean) : [];
      out.replaceChildren(
        ...sec('Songs', j.tracks, t => playRow(t, () => Cmd.play({ uris: tr.map(x => x.uri).slice(tr.indexOf(t)) }))),
        ...sec('Albums', j.albums, a => h('button', { class: 'row', onclick: () => Cmd.play({ context_uri: a.uri }) }, img(a.images), h('div', { class: 'meta' }, h('div', { class: 't1' }, a.name), h('div', { class: 't2' }, artists(a))))),
        ...sec('Playlists', j.playlists, p => h('button', { class: 'row', onclick: () => Cmd.play({ context_uri: p.uri }) }, img(p.images), h('div', { class: 'meta' }, h('div', { class: 't1' }, p.name), h('div', { class: 't2' }, (p.owner || {}).display_name || '')))));
    } catch (e) { out.replaceChildren(errBox(e)); }
  };
  input.addEventListener('input', debounce(run, 350));
  view.replaceChildren(h('h1', {}, 'Search'), input, out);
  if (input.value) run();
}

/* ---------- Marketplace ---------- */
const MK = { kind: 'ext', q: '', page: 1 };
async function ghJson(url) {
  const ck = 'sw.c.' + url;
  try { const c = JSON.parse(sessionStorage.getItem(ck)); if (c && Date.now() - c.t < 600000) return c.v; } catch { /* no cache */ }
  const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (r.status === 403 || r.status === 429) throw new Error('GitHub rate limit reached. Try again in a few minutes.');
  if (!r.ok) throw new Error('GitHub returned ' + r.status);
  const v = await r.json();
  try { sessionStorage.setItem(ck, JSON.stringify({ t: Date.now(), v })); } catch { /* cache full */ }
  return v;
}
const rawBase = repo => `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/`;
const absUrl = (base, p) => !p ? '' : /^https?:/.test(p) ? p : base + p.replace(/^\.?\//, '');
async function repoItems(repo, kind) {
  const base = rawBase(repo);
  try {
    const r = await fetch(base + 'manifest.json');
    if (r.ok) {
      let m = await r.json(); m = Array.isArray(m) ? m : [m];
      const items = m.filter(x => x && (kind === 'ext' ? x.main : (x.schemes || x.usercss))).map(x => ({
        name: x.name || repo.name, desc: x.description || repo.description || '', main: x.main, schemes: x.schemes,
        preview: absUrl(base, x.preview), base, repo: repo.full_name,
      }));
      if (items.length) return items;
    }
  } catch { /* fall through */ }
  if (kind === 'ext') {
    const files = await ghJson(`https://api.github.com/repos/${repo.full_name}/contents`);
    return files.filter(f => f.type === 'file' && /\.js$/i.test(f.name) && !/(config|webpack|rollup|eslint|vite|gulp|babel)/i.test(f.name))
      .map(f => ({ name: f.name.replace(/\.js$/i, ''), desc: repo.description || '', main: f.path, base, repo: repo.full_name }));
  }
  return [];
}
function parseIni(txt) {
  const out = {}; let cur = null;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === ';' || line[0] === '#') continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { cur = out[sec[1]] = {}; continue; }
    const kv = line.match(/^([^=]+?)\s*=\s*(.+)$/);
    if (kv && cur) cur[kv[1].trim().toLowerCase()] = kv[2].trim();
  }
  return out;
}
const hex = v => /^#?[0-9a-f]{6}$/i.test(v || '') ? '#' + v.replace('#', '') : null;
const THEME_MAP = { main: '--bg', sidebar: '--panel', card: '--card', 'main-elevated': '--card', 'highlight-elevated': '--row', 'selected-row': '--row', text: '--fg', subtext: '--muted', button: '--accent', 'button-active': '--accent' };
function schemeVars(sec) {
  const vars = {};
  for (const [k, cssVar] of Object.entries(THEME_MAP)) { const c = hex(sec[k]); if (c) vars[cssVar] = c; }
  if (vars['--accent']) { const n = parseInt(vars['--accent'].slice(1), 16), lum = ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000; vars['--accent-ink'] = lum > 140 ? '#101010' : '#ffffff'; }
  return vars;
}
function applyTheme(t) {
  const root = document.documentElement;
  Object.values(THEME_MAP).concat(['--accent-ink']).forEach(v => root.style.removeProperty(v));
  if (t && t.vars) Object.entries(t.vars).forEach(([k, v]) => root.style.setProperty(k, v));
}
async function fetchText(url) {
  const r = await fetch(url); if (!r.ok) throw new Error('Could not download ' + url.split('/').pop() + ' (' + r.status + ')');
  return r.text();
}
function normalizeUrl(u) {
  u = u.trim();
  const m = u.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+)$/);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}` : u;
}
async function installExt({ name, url, repo }) {
  const code = await fetchText(url);
  const list = LS.get('exts', []).filter(e => e.url !== url);
  const rec = { id: 'x' + Date.now().toString(36), name, url, repo: repo || '', enabled: true };
  list.push(rec); LS.set('exts', list); LS.set('code.' + rec.id, code);
  Ext.start(rec, code); toast(name + ' installed');
}
function installedExts() { return LS.get('exts', []); }

function marketCard(repo) {
  const itemsBox = h('div', { class: 'items', hidden: true });
  const kind = MK.kind;
  const open = h('button', { class: 'btn' }, kind === 'ext' ? 'See extensions' : 'See color schemes');
  open.onclick = async () => {
    open.disabled = true; open.textContent = 'Loading…';
    try {
      const items = await repoItems(repo, kind);
      if (!items.length) itemsBox.replaceChildren(h('p', { class: 'muted small' }, kind === 'ext' ? 'No installable extension files found in this repo.' : 'This theme has no color schemes. Spicetify CSS themes cannot style this app.'));
      else itemsBox.replaceChildren(...items.map(it => kind === 'ext' ? extItem(it) : themeItem(it)));
      itemsBox.hidden = false; open.remove();
    } catch (e) { open.disabled = false; open.textContent = 'Try again'; toast(e.message, true); }
  };
  return h('div', { class: 'card' },
    h('h3', {}, repo.name), h('div', { class: 'desc' }, repo.description || 'No description.'),
    h('div', { class: 'small muted' }, `${repo.owner.login} · ${repo.stargazers_count} stars · `, h('a', { href: repo.html_url, target: '_blank', rel: 'noopener' }, 'GitHub')),
    h('div', { class: 'acts' }, open), itemsBox);
}
function extItem(it) {
  const url = absUrl(it.base, it.main), done = installedExts().some(e => e.url === url);
  const b = h('button', { class: 'btn' + (done ? ' ghost' : '') }, done ? 'Reinstall' : 'Install');
  b.onclick = async () => { b.disabled = true; try { await installExt({ name: it.name, url, repo: it.repo }); b.textContent = 'Installed'; } catch (e) { toast(e.message, true); b.disabled = false; } };
  return h('div', { class: 'card' }, it.preview && h('img', { class: 'pv', src: it.preview, alt: '', loading: 'lazy' }), h('h3', {}, it.name), h('div', { class: 'desc' }, it.desc), h('div', { class: 'acts' }, b));
}
function themeItem(it) {
  const paths = typeof it.schemes === 'string' ? [it.schemes] : Array.isArray(it.schemes) ? it.schemes : it.schemes ? Object.values(it.schemes) : [];
  const sel = h('select', { 'aria-label': 'Color scheme for ' + it.name });
  const apply = h('button', { class: 'btn', disabled: true }, 'Apply');
  let all = {};
  Promise.all(paths.map(p => fetchText(absUrl(it.base, p)).then(parseIni).catch(() => ({})))).then(parts => {
    parts.forEach(o => Object.assign(all, o));
    Object.keys(all).forEach(n => sel.append(h('option', { value: n }, n)));
    apply.disabled = !Object.keys(all).length;
  });
  apply.onclick = () => { const vars = schemeVars(all[sel.value] || {}); const t = { name: it.name + ' / ' + sel.value, vars }; LS.set('theme', t); applyTheme(t); toast('Applied ' + t.name); };
  return h('div', { class: 'card' }, it.preview && h('img', { class: 'pv', src: it.preview, alt: '', loading: 'lazy' }), h('h3', {}, it.name), h('div', { class: 'desc' }, it.desc),
    h('div', { class: 'acts' }, sel, apply), h('div', { class: 'small muted' }, 'Only the color scheme is used. The theme\'s CSS targets Spotify\'s desktop app.'));
}

async function marketView() {
  const tabs = h('div', { class: 'tabs' }, ...[['ext', 'Extensions'], ['theme', 'Color schemes'], ['mine', 'Installed']].map(([id, l]) =>
    h('button', { class: 'chip', 'aria-pressed': MK.kind === id, onclick: () => { MK.kind = id; MK.page = 1; marketView(); } }, l)));
  if (MK.kind === 'mine') return installedView(tabs);
  const grid = h('div', { style: 'display:grid;gap:.8rem' }), more = h('button', { class: 'btn ghost', hidden: true }, 'Load more');
  const input = h('input', { type: 'search', id: 'mq', placeholder: 'Search the Marketplace', value: MK.q, 'aria-label': 'Search the Marketplace' });
  input.addEventListener('input', debounce(() => { MK.q = input.value; MK.page = 1; load(true); }, 450));
  view.replaceChildren(h('h1', {}, 'Marketplace'), tabs, input, grid, more,
    h('p', { class: 'small muted' }, 'Results come from GitHub repositories tagged ', h('code', {}, MK.kind === 'ext' ? 'spicetify-extensions' : 'spicetify-themes'), '. Extensions are third-party code. They run in a sandbox without access to your Spotify login, but they can see what is playing and call the Spotify API on your behalf.'));
  async function load(reset) {
    if (reset) grid.replaceChildren(h('p', { class: 'muted' }, 'Searching…'));
    try {
      const topic = MK.kind === 'ext' ? 'spicetify-extensions' : 'spicetify-themes';
      const j = await ghJson('https://api.github.com/search/repositories?' + new URLSearchParams({ q: (MK.q ? MK.q + ' ' : '') + 'topic:' + topic, sort: 'stars', per_page: 20, page: MK.page }));
      if (reset) grid.replaceChildren();
      if (!j.items.length && reset) grid.replaceChildren(h('p', { class: 'muted' }, 'Nothing found.'));
      j.items.forEach(r => grid.append(marketCard(r)));
      more.hidden = j.items.length < 20;
    } catch (e) { if (reset) grid.replaceChildren(errBox(e)); else toast(e.message, true); }
  }
  more.onclick = () => { MK.page++; load(false); };
  load(true);
}
function installedView(tabs) {
  const list = installedExts(), theme = LS.get('theme');
  const urlIn = h('input', { type: 'text', id: 'exturl', placeholder: 'https://github.com/user/repo/blob/main/extension.js', 'aria-label': 'Extension URL' });
  const add = h('button', { class: 'btn' }, 'Install from URL');
  add.onclick = async () => {
    const u = normalizeUrl(urlIn.value); if (!/^https:\/\//.test(u)) return toast('Enter an https URL to a .js file.', true);
    try { await installExt({ name: decodeURIComponent(u.split('/').pop().replace(/\.js.*$/, '')) || 'Extension', url: u }); marketView(); } catch (e) { toast(e.message, true); }
  };
  view.replaceChildren(h('h1', {}, 'Marketplace'), tabs,
    h('h2', {}, 'Extensions'),
    list.length ? list.map(e => h('div', { class: 'card' }, h('h3', {}, e.name), h('div', { class: 'small muted' }, e.repo || e.url),
      h('div', { class: 'acts' },
        h('button', { class: 'btn ghost', onclick: () => { e.enabled = !e.enabled; LS.set('exts', list); e.enabled ? Ext.start(e, LS.get('code.' + e.id, '')) : Ext.stop(e.id); marketView(); } }, e.enabled ? 'Turn off' : 'Turn on'),
        h('button', { class: 'btn ghost', onclick: async () => { try { const code = await fetchText(e.url); LS.set('code.' + e.id, code); if (e.enabled) { Ext.stop(e.id); Ext.start(e, code); } toast('Updated ' + e.name); } catch (er) { toast(er.message, true); } } }, 'Update'),
        h('button', { class: 'btn ghost', onclick: () => { Ext.stop(e.id); LS.set('exts', list.filter(x => x.id !== e.id)); LS.del('code.' + e.id); LS.del('ls.' + e.id); marketView(); } }, 'Remove')),
      Ext.actions.filter(a => a.ext === e.id).length ? h('div', { class: 'acts' }, Ext.actions.filter(a => a.ext === e.id).map(Ext.actionBtn)) : null)) :
      h('p', { class: 'muted' }, 'No extensions yet. Install one from the Extensions tab, or paste a link below.'),
    h('div', { class: 'field' }, h('label', { for: 'exturl' }, 'Install from a link'), urlIn, add),
    h('h2', {}, 'Color scheme'),
    h('div', { class: 'card' }, h('div', {}, theme ? theme.name : 'Default'), theme ? h('button', { class: 'btn ghost', onclick: () => { LS.del('theme'); applyTheme(null); marketView(); } }, 'Reset to default') : null),
    h('h2', {}, 'Extension log'),
    h('div', { class: 'card log' }, Ext.log.length ? Ext.log.slice(-60).map(l => h('div', { class: l.lvl }, `[${l.name}] ${l.msg}`)) : h('div', { class: 'muted' }, 'Nothing logged yet.')));
}

/* ---------- settings ---------- */
function settingsView() {
  const id = h('input', { type: 'text', id: 'cid', value: LS.get('clientId', ''), placeholder: '32-character Client ID', autocomplete: 'off', 'aria-label': 'Spotify Client ID' });
  const save = h('button', { class: 'btn' }, 'Save');
  save.onclick = () => { LS.set('clientId', id.value.trim()); toast('Saved'); };
  const copy = h('button', { class: 'btn ghost' }, 'Copy');
  copy.onclick = () => navigator.clipboard.writeText(redirectUri).then(() => toast('Copied'), () => toast('Select the address and copy it.', true));
  const sdk = h('input', { type: 'checkbox', id: 'sdk', checked: !!LS.get('sdk') });
  sdk.addEventListener('change', () => { LS.set('sdk', sdk.checked); if (sdk.checked && LS.get('tok')) enableSdk(); else toast('Takes effect after reload.'); });
  view.replaceChildren(h('h1', {}, 'Settings'),
    h('div', { class: 'card' }, h('h2', {}, 'Spotify access'),
      h('ol', { class: 'small', style: 'margin:0;padding-left:1.2rem;display:grid;gap:.3rem' },
        h('li', {}, 'Create an app at developer.spotify.com/dashboard.'),
        h('li', {}, 'Add this Redirect URI to the app:'),
        h('li', {}, 'Paste its Client ID below and save, then sign in.')),
      h('div', { class: 'acts' }, h('code', {}, redirectUri), copy),
      h('div', { class: 'field' }, h('label', { for: 'cid' }, 'Client ID'), id), h('div', { class: 'acts' }, save,
        LS.get('tok') ? h('button', { class: 'btn ghost', onclick: logout }, 'Sign out') : h('button', { class: 'btn ghost', onclick: login }, 'Sign in'))),
    h('div', { class: 'card' }, h('h2', {}, 'Playback'),
      h('div', { class: 'small muted' }, 'By default this app remote-controls the Spotify app on your phone or any other device on your account. Use the device button in the player to switch.'),
      h('label', { class: 'acts small', for: 'sdk' }, sdk, 'Also make this browser a playback device (desktop browsers, Premium)'),
      h('button', { class: 'btn ghost', onclick: openDevices }, 'Choose device')));
}

/* ---------- Extension runtime ---------- */
/* shimMain is stringified into each sandboxed iframe. It must not reference anything outside itself. */
function shimMain() {
  const I = window.__INIT || {}, pending = {}, L = {}; let nid = 0, S = Object.assign({ playing: false, progress: 0, duration: 0, ts: Date.now(), volume: 50, shuffle: false, repeat: 'off', item: null }, I.state, { ts: Date.now() }), store = I.ls || {}, shortcuts = [];
  const call = (m, ...a) => new Promise((res, rej) => { const id = ++nid; pending[id] = { res, rej }; parent.postMessage({ __sp: 1, id, m, a }, '*'); });
  const emit = (t, d) => (L[t] || []).slice().forEach(f => { try { f({ data: d }); } catch (e) { call('log', 'error', String(e)); } });
  const meta = it => it ? { uri: it.uri, name: it.name, artists: it.artists, album: it.album, duration: { milliseconds: it.duration_ms }, metadata: { title: it.name, artist_name: (it.artists || []).map(a => a.name).join(', '), album_title: (it.album || {}).name || '', image_url: (((it.album || {}).images || [])[0] || {}).url || '', duration: String(it.duration_ms) } } : null;
  addEventListener('message', e => {
    const d = e.data; if (!d || !d.__sp || e.source !== parent) return;
    if (d.reply) { const p = pending[d.id]; delete pending[d.id]; if (p) d.err ? p.rej(new Error(d.err)) : p.res(d.v); return; }
    if (d.event === 'init') { store = d.v.ls || {}; S = Object.assign(d.v.state, { ts: Date.now() }); return; }
    if (d.event === 'action') { const a = actions[d.v]; if (a) try { a(); } catch (x) { call('log', 'error', String(x)); } return; }
    if (d.event === 'keydown') { shortcuts.forEach(s => { const k = s.k; if (String(k.key).toLowerCase() === d.v.key.toLowerCase() && !!k.ctrl === d.v.ctrl && !!k.shift === d.v.shift && !!k.alt === d.v.alt) s.cb(); }); return; }
    if (d.event === 'songchange' || d.event === 'onplaypause') { S = Object.assign(d.v, { ts: Date.now() }); emit(d.event, Spicetify.Player.data); }
  });
  const actions = {}; let aid = 0;
  const reg = (kind, label, cb) => { const id = ++aid; actions[id] = cb; call('action', id, kind, label); return id; };
  const prog = () => S.playing ? Math.min(S.duration, S.progress + Date.now() - S.ts) : S.progress;
  setInterval(() => { if (S.playing) emit('onprogress', prog()); }, 1000);
  const Player = {
    addEventListener(t, f) { (L[t] = L[t] || []).push(f); }, removeEventListener(t, f) { L[t] = (L[t] || []).filter(x => x !== f); },
    getProgress: prog, getProgressPercent: () => S.duration ? prog() / S.duration : 0, getDuration: () => S.duration,
    isPlaying: () => S.playing, getVolume: () => S.volume / 100, getShuffle: () => S.shuffle, getRepeat: () => ({ off: 0, context: 1, track: 2 })[S.repeat] || 0, getMute: () => false,
    play: () => call('player', 'play'), pause: () => call('player', 'pause'), togglePlay: () => call('player', S.playing ? 'pause' : 'play'),
    next: () => call('player', 'next'), back: () => call('player', 'prev'),
    seek: p => call('player', 'seek', p < 1 ? Math.round(p * S.duration) : p), setVolume: v => call('player', 'volume', Math.round(v * 100)),
    toggleShuffle: () => call('player', 'shuffle'), toggleRepeat: () => call('player', 'repeat'),
    playUri: (uri, ctx) => call('player', 'playUri', uri, ctx),
    get data() { return S.item ? { item: S.item, track: meta(S.item), is_paused: !S.playing, position: prog(), duration: S.duration } : null; },
  };
  const fromString = s => { const p = String(s).split(':'); return { uri: s, type: p[1], id: p[2], toURI: () => s }; };
  const asUrl = u => String(u).replace(/^sp:\/\/|^spotify:/, '');
  const cosmos = m => (url, body) => call('api', m, url, body);
  const Spicetify = {
    version: 'spindle-0.1', Player, URI: Object.assign(fromString, { fromString, isTrack: s => /^spotify:track:/.test(s), isAlbum: s => /^spotify:album:/.test(s), isArtist: s => /^spotify:artist:/.test(s), isPlaylist: s => /^spotify:playlist:/.test(s) }),
    showNotification: (t, isErr) => call('notify', String(t), !!isErr),
    addToQueue: items => Promise.all([].concat(items).map(i => call('player', 'queue', i.uri))),
    CosmosAsync: { get: cosmos('GET'), post: cosmos('POST'), put: cosmos('PUT'), del: cosmos('DELETE'), delete: cosmos('DELETE'), resolve: (m, u, b) => call('api', m, u, b) },
    LocalStorage: { get: k => (k in store ? store[k] : null), set: (k, v) => { store[k] = String(v); call('ls', 'set', k, String(v)); }, remove: k => { delete store[k]; call('ls', 'remove', k); }, clear: () => { store = {}; call('ls', 'clear'); } },
    Keyboard: { registerShortcut: (k, cb) => { if (typeof k === 'string') k = { key: k }; if (Array.isArray(k)) k = { key: k[k.length - 1] }; shortcuts.push({ k, cb }); }, registerIsolatedShortcut(k, cb) { this.registerShortcut(k, cb); }, KEYS: { SPACE: ' ', ARROW_LEFT: 'ArrowLeft', ARROW_RIGHT: 'ArrowRight', ARROW_UP: 'ArrowUp', ARROW_DOWN: 'ArrowDown' } },
    Topbar: { Button: class { constructor(label, icon, onClick) { this.label = label; reg('topbar', label, () => onClick(this)); } } },
    Menu: { Item: class { constructor(name, isEnabled, onClick) { this.name = name; reg('menu', name, () => onClick(this)); } setState() {} setName() {} register() {} deregister() {} } },
    ContextMenu: { Item: class { constructor(name, onClick) { reg('menu', name, () => onClick([S.item && S.item.uri].filter(Boolean))); } register() {} deregister() {} } },
    Platform: { version: 'spindle', History: { location: { pathname: '/' }, listen: () => () => {}, push() {} } },
    Config: { version: 'spindle' }, Locale: { get: k => k }, SVGIcons: {}, test: () => true,
  };
  window.Spicetify = Spicetify;
  window.addEventListener('error', e => call('log', 'error', e.message));
  window.addEventListener('unhandledrejection', e => call('log', 'error', String(e.reason)));
  console.log = (...a) => call('log', 'log', a.map(String).join(' '));
  console.error = (...a) => call('log', 'error', a.map(String).join(' '));
  console.warn = console.log; console.info = console.log;
}

const Ext = {
  frames: new Map(), actions: [], log: [],
  snapshot() {
    const s = P.s, it = s && s.item;
    return { playing: !!(s && s.is_playing), progress: s ? s.progress_ms : 0, duration: it ? it.duration_ms : 0, volume: s && s.device ? s.device.volume_percent : 50, shuffle: !!(s && s.shuffle_state), repeat: s ? s.repeat_state : 'off', item: it || null };
  },
  post(f, msg) { try { f.win.postMessage(Object.assign({ __sp: 1 }, msg), '*'); } catch { /* frame gone */ } },
  emit(ev) { this.frames.forEach(f => this.post(f, { event: ev, v: this.snapshot() })); },
  start(rec, code) {
    if (this.frames.has(rec.id) || !code) return;
    const fr = h('iframe', { sandbox: 'allow-scripts', title: rec.name, style: 'display:none', 'aria-hidden': 'true' });
    const entry = { rec, el: fr, win: null };
    const init = JSON.stringify({ state: this.snapshot(), ls: LS.get('ls.' + rec.id, {}) }).replace(/</g, '\\u003c');
    fr.srcdoc = '<!doctype html><meta charset="utf-8"><script>window.__INIT=' + init + '<\/script><script>(' + shimMain.toString() + ')()<\/script><script>\n' + code.replace(/<\/script/gi, '<\\/script') + '\n<\/script>';
    fr.addEventListener('load', () => { entry.win = fr.contentWindow; this.post(entry, { event: 'init', v: { state: this.snapshot(), ls: LS.get('ls.' + rec.id, {}) } }); });
    this.frames.set(rec.id, entry);
    document.body.append(fr); entry.win = fr.contentWindow;
  },
  stop(id) { const f = this.frames.get(id); if (f) { f.el.remove(); this.frames.delete(id); } this.actions = this.actions.filter(a => a.ext !== id); renderTopButtons(); },
  note(rec, lvl, msg) { this.log.push({ name: rec.name, lvl, msg: String(msg).slice(0, 400) }); if (this.log.length > 200) this.log.shift(); },
  actionBtn(a) { return h('button', { class: 'chip', onclick: () => Ext.post(Ext.frames.get(a.ext), { event: 'action', v: a.id }) }, a.label); },
  async handle(entry, m, a) {
    const rec = entry.rec;
    switch (m) {
      case 'log': this.note(rec, a[0], a[1]); return;
      case 'notify': toast(a[0], a[1]); return;
      case 'action': this.actions.push({ ext: rec.id, id: a[0], kind: a[1], label: a[2] }); renderTopButtons(); renderSheet(); return;
      case 'ls': { const o = LS.get('ls.' + rec.id, {}); if (a[0] === 'set') o[a[1]] = a[2]; else if (a[0] === 'remove') delete o[a[1]]; else Object.keys(o).forEach(k => delete o[k]); LS.set('ls.' + rec.id, o); return; }
      case 'player': {
        const [op, x, y] = a;
        if (op === 'play') return Cmd.play(); if (op === 'pause') return Cmd.pause(); if (op === 'next') return Cmd.next(); if (op === 'prev') return Cmd.prev();
        if (op === 'seek') return Cmd.seek(+x); if (op === 'volume') return Cmd.volume(+x); if (op === 'shuffle') return Cmd.shuffle(); if (op === 'repeat') return Cmd.repeat();
        if (op === 'queue') return Cmd.queue(String(x));
        if (op === 'playUri') return Cmd.play(/:(album|playlist|artist|show)/.test(x) ? { context_uri: x } : { uris: [x] });
        throw new Error('Unsupported player call');
      }
      case 'api': {
        let [method, url, body] = a; url = String(url);
        if (url.startsWith('sp://') || url.startsWith('hm://')) throw new Error('Spotify desktop endpoints are not available here');
        if (url.startsWith('/')) url = 'https://api.spotify.com' + (url.startsWith('/v1/') ? '' : '/v1') + url;
        if (!/^https:\/\/api\.spotify\.com\/v1\//.test(url)) throw new Error('Only api.spotify.com/v1 is allowed');
        if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) throw new Error('Bad method');
        return api(url, { method, body: method === 'GET' ? undefined : body, query: method === 'GET' && body && typeof body === 'object' ? body : undefined });
      }
      default: throw new Error('Unknown call ' + m);
    }
  },
};
window.addEventListener('message', async e => {
  const d = e.data; if (!d || !d.__sp || d.reply || d.event) return;
  const entry = [...Ext.frames.values()].find(f => f.el.contentWindow === e.source); if (!entry) return;
  try { const v = await Ext.handle(entry, d.m, d.a || []); if (d.id) e.source.postMessage({ __sp: 1, reply: true, id: d.id, v: v === undefined ? null : v }, '*'); }
  catch (err) { Ext.note(entry.rec, 'error', err.message); if (d.id) e.source.postMessage({ __sp: 1, reply: true, id: d.id, err: err.message }, '*'); }
});
document.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|SELECT/.test((e.target || {}).tagName)) return;
  Ext.frames.forEach(f => Ext.post(f, { event: 'keydown', v: { key: e.key, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey } }));
});
function renderTopButtons() { if (sheetOpen) renderSheet(); }

/* ---------- router & boot ---------- */
function route() {
  const [, name = 'home', arg] = location.hash.split('/');
  renderNav(name === 'playlist' ? 'home' : name);
  view.scrollTo(0, 0);
  if (name === 'market') return marketView();
  if (name === 'settings') return settingsView();
  if (!LS.get('tok')) return signInView();
  if (name === 'search') return searchView();
  if (name === 'playlist') return playlistView(arg);
  return homeView();
}
window.addEventListener('hashchange', route);
let lastKey = '';
onState(() => {
  const s = P.s, key = s && s.item ? [s.item.uri, s.is_playing, s.shuffle_state, s.repeat_state].join('|') : 'none';
  if (key !== lastKey) { lastKey = key; renderBar(); renderSheet(); }
});

(async function boot() {
  applyTheme(LS.get('theme'));
  try { if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {}); } catch { /* no SW */ }
  try { await handleCallback(); } catch (e) { toast(e.message, true); }
  renderBar(); route();
  if (LS.get('tok')) { if (LS.get('sdk')) enableSdk(); await poll(); setInterval(poll, 3000); setInterval(tickProgress, 500); }
  installedExts().filter(e => e.enabled).forEach(e => Ext.start(e, LS.get('code.' + e.id, '')));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.setActionHandler('play', Cmd.toggle); navigator.mediaSession.setActionHandler('pause', Cmd.toggle); navigator.mediaSession.setActionHandler('nexttrack', Cmd.next); navigator.mediaSession.setActionHandler('previoustrack', Cmd.prev); } catch { /* unsupported */ }
  }
})();
