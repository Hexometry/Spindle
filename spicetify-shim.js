/* Spicetify compatibility layer for Spindle.
   Implements a subset of the global `Spicetify` object that many extensions use,
   on top of Spindle's player core (window.Spindle). Not supported: Spicetify.React,
   ReactDOM, Platform internals, themes/CSS injection into Spotify's UI. */
(() => {
  const C = window.Spindle;
  const toast = (msg, isError, ms = 3000) => {
    const d = document.createElement("div");
    d.className = "toast" + (isError ? " err" : "");
    d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), ms);
  };

  /* ---- URI ---- */
  const Type = { TRACK: "track", ALBUM: "album", ARTIST: "artist", PLAYLIST: "playlist", PLAYLIST_V2: "playlist-v2",
                 SHOW: "show", EPISODE: "episode", USER: "user", COLLECTION: "collection", FOLDER: "folder" };
  const URI = {
    Type,
    fromString(s) {
      const m = String(s).match(/^spotify:([a-z\-]+):([A-Za-z0-9]+)/) ||
                String(s).match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?([a-z]+)\/([A-Za-z0-9]+)/);
      if (!m) return null;
      const uri = `spotify:${m[1]}:${m[2]}`;
      return { type: m[1], id: m[2], _base62Id: m[2], uri, toURI: () => uri, toString: () => uri };
    },
    isTrack: u => (URI.fromString(u) || {}).type === "track",
    isAlbum: u => (URI.fromString(u) || {}).type === "album",
    isArtist: u => (URI.fromString(u) || {}).type === "artist",
    isPlaylistV1OrV2: u => ["playlist", "playlist-v2"].includes((URI.fromString(u) || {}).type),
    isEpisode: u => (URI.fromString(u) || {}).type === "episode",
    isShow: u => (URI.fromString(u) || {}).type === "show",
  };

  /* ---- Player ---- */
  const ev = { songchange: "songchange", onplaypause: "playpause", onprogress: "progress" };
  const Player = {
    addEventListener: (t, cb) => ev[t] && C.on(ev[t], cb),
    removeEventListener: (t, cb) => ev[t] && C.off(ev[t], cb),
    play: () => { if (!C.S.playing) C.toggle(); },
    pause: () => { if (C.S.playing) C.toggle(); },
    togglePlay: () => C.toggle(),
    next: () => C.next(),
    back: () => C.prev(),
    seek: ms => C.seek(ms),
    getProgress: () => C.position(),
    getProgressPercent: () => (C.S.dur ? C.position() / C.S.dur : 0),
    getDuration: () => C.S.dur,
    isPlaying: () => C.S.playing,
    getVolume: () => 1, setVolume() {}, getMute: () => false, setMute() {}, toggleMute() {},
    getShuffle: () => false, getRepeat: () => 0, getHeart: () => false, toggleHeart() {},
    get data() { return C.data(); },
  };

  /* ---- Storage / misc ---- */
  const LocalStorage = {
    get: k => { try { return localStorage.getItem("spicetify:" + k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem("spicetify:" + k, v); } catch {} },
    remove: k => { try { localStorage.removeItem("spicetify:" + k); } catch {} },
    clear() {},
  };

  const CosmosAsync = {
    async get(url, body) {
      let u = String(url).replace(/^https:\/\/api\.spotify\.com/, "");
      if (!u.startsWith("/v1/")) throw new Error("Spindle: unsupported endpoint " + url);
      if (body && typeof body === "object") u += (u.includes("?") ? "&" : "?") + new URLSearchParams(body);
      const r = await fetch("/api?path=" + encodeURIComponent(u));
      if (!r.ok) throw new Error("Spotify API " + r.status);
      return r.json();
    },
  };
  for (const m of ["post", "put", "del", "patch"])
    CosmosAsync[m] = async () => { throw new Error("Spindle: CosmosAsync is read-only (GET only)"); };

  /* ---- UI registries ---- */
  const iconHTML = (icon, label) => (typeof icon === "string" && icon.trim().startsWith("<")) ? icon : (label || "•").slice(0, 2);
  function ButtonClass(containerId) {
    return class {
      constructor(label, icon, onClick, disabled = false) {
        this.onClick = onClick; this.disabled = disabled;
        const b = this.element = document.createElement("button");
        b.className = "xbtn"; b.title = label; b.innerHTML = iconHTML(icon, label);
        b.disabled = !!disabled;
        b.onclick = () => this.onClick && this.onClick(this);
        const box = document.getElementById(containerId); if (box) box.appendChild(b);
      }
      set label(v) { this.element.title = v; }
      set icon(v) { this.element.innerHTML = iconHTML(v); }
      deregister() { this.element.remove(); }
    };
  }
  class MenuItem {
    constructor(name, isEnabled, onClick, icon) { Object.assign(this, { name, isEnabled, onClick, icon }); }
    setState(v) { this.isEnabled = v; C.ui && C.ui.refreshPanel(); }
    register() { C.menuItems.add(this); C.ui && C.ui.refreshPanel(); }
    deregister() { C.menuItems.delete(this); C.ui && C.ui.refreshPanel(); }
  }
  class CtxItem {
    constructor(name, onClick, shouldAdd = () => true, icon, disabled) { Object.assign(this, { name, onClick, shouldAdd, icon, disabled }); }
    register() { C.ctxItems.add(this); C.ui && C.ui.refreshPanel(); }
    deregister() { C.ctxItems.delete(this); C.ui && C.ui.refreshPanel(); }
  }
  const Keyboard = {
    registerShortcut(keys, cb) {
      const k = typeof keys === "string" ? keys.toLowerCase().split("+") : [String(keys.key).toLowerCase()].concat(
        ["ctrl", "shift", "alt", "meta"].filter(m => keys[m]));
      const key = k.find(x => !["ctrl", "shift", "alt", "meta"].includes(x));
      addEventListener("keydown", e => {
        if (/input|textarea|select/i.test((e.target || {}).tagName)) return;
        if (e.key.toLowerCase() === key && ["ctrl", "shift", "alt", "meta"].every(m => e[m + "Key"] === k.includes(m))) { e.preventDefault(); cb(e); }
      });
    },
    registerImportantShortcut(...a) { return this.registerShortcut(...a); },
  };

  window.Spicetify = {
    Player, URI, LocalStorage, CosmosAsync, Keyboard,
    showNotification: toast,
    Topbar: { Button: ButtonClass("tb") },
    Playbar: { Button: ButtonClass("pb") },
    Menu: { Item: MenuItem },
    ContextMenu: { Item: CtxItem },
    SVGIcons: new Proxy({}, { get: () => "" }),
    Platform: { version: "spindle", PlayerAPI: {}, LibraryAPI: {}, History: { location: { pathname: "/" }, listen: () => () => {}, push() {} } },
    Config: { version: "spindle", current_theme: "", color_scheme: "", extensions: [], custom_apps: [] },
    Queue: { track: null, nextTracks: [], prevTracks: [] },
    isAppDeveloperMode: () => false,
  };
})();
