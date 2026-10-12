"""Spindle backend: key login + SpotAPI (cookie-based) playback control.

No Spotify developer app is needed. The server logs in to Spotify with YOUR
browser cookie (SPOTAPI_COOKIE_DUMP) and controls whatever Spotify device is
active on your account. Visitors unlock the site with SPINDLE_PLAYBACK_KEY.

Render environment variables (never commit these):
  FLASK_SECRET_KEY        signs the login cookie (render.yaml generates it)
  SPINDLE_PLAYBACK_KEY    the key you type on the /login page
  SPOTAPI_COOKIE_DUMP     {"identifier":"you@email","cookies":{"sp_dc":"..."}}
"""
import hmac
import json
import os
import threading
import time
from datetime import timedelta
from html import escape

from flask import Flask, abort, jsonify, redirect, request, send_from_directory, session

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=None)  # no folders: files sit next to app.py
app.secret_key = os.environ["FLASK_SECRET_KEY"]
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=os.environ.get("SPINDLE_INSECURE_COOKIES") != "1",  # "1" only for local http testing
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)


def env(name):
    # Strip stray spaces/newlines that often sneak in when pasting values
    return os.environ.get(name, "").strip()


# ---------- key login ----------

_fails, _fail_lock = [], threading.Lock()  # timestamps of recent wrong keys
MAX_FAILS, FAIL_WINDOW = 8, 15 * 60


def _locked_out():
    now = time.time()
    with _fail_lock:
        _fails[:] = [t for t in _fails if now - t < FAIL_WINDOW]
        return len(_fails) >= MAX_FAILS


def _record_fail():
    with _fail_lock:
        _fails.append(time.time())


def logged_in():
    return session.get("ok") is True


def needs_login(fn):
    def wrapper(*a, **kw):
        if not logged_in():
            return jsonify(error="not_logged_in"), 401
        return fn(*a, **kw)
    wrapper.__name__ = fn.__name__
    return wrapper


@app.before_request
def block_cross_site_posts():
    # Belt and braces on top of SameSite=Lax cookies.
    if request.method == "POST" and request.headers.get("Sec-Fetch-Site") == "cross-site":
        abort(403)


LOGIN_PAGE = """<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#14110f">
<title>Spindle login</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#14110f;color:#f1ebe4;font:16px/1.4 system-ui,sans-serif}
form{width:min(90vw,22rem);display:flex;flex-direction:column;gap:.7rem}
h1{margin:0 0 .3rem;font-size:1.35rem}
input,button{font:inherit;padding:.8rem .9rem;border-radius:.6rem;border:1px solid #37302b}
input{background:#201b18;color:#f1ebe4}button{background:#e8b04a;color:#14110f;font-weight:600;border:0}
p{margin:0;color:#e0705a;min-height:1.4em}small{color:#a39a91}
</style></head><body><form method="post" action="/login"><h1>Spindle</h1>
<input type="password" name="key" placeholder="Access key" autocomplete="current-password" autofocus required>
<button>Log in</button><p>%s</p><small>Enter the SPINDLE_PLAYBACK_KEY you set on Render.</small></form></body></html>"""


@app.route("/login", methods=["GET", "POST"])
def login():
    expected = env("SPINDLE_PLAYBACK_KEY")
    if not expected:
        return "Login isn't set up yet. Set SPINDLE_PLAYBACK_KEY in Render's Environment tab.", 503
    if request.method == "GET":
        return LOGIN_PAGE % ""
    if _locked_out():
        return LOGIN_PAGE % escape("Too many wrong keys. Try again in a few minutes."), 429
    supplied = request.form.get("key", "")
    if hmac.compare_digest(supplied.encode(), expected.encode()):
        session.clear()
        session["ok"] = True
        session.permanent = True
        return redirect("/")
    _record_fail()
    return LOGIN_PAGE % "Wrong key.", 401


@app.get("/logout")
def logout():
    session.clear()
    return redirect("/")


@app.get("/me")
def me():
    if not logged_in():
        return jsonify(logged_in=False)
    return jsonify(logged_in=True, name="Signed in", mode="remote")


@app.get("/token")
def token():
    # The official Web Playback SDK needs a developer-app token; not used in this mode.
    return jsonify(error="not_available"), 401


@app.get("/api")
def api_proxy():
    return jsonify(error="Spotify Web API passthrough isn't available in key-login mode."), 501


# ---------- SpotAPI player (single owner account) ----------

class PlayerUnavailable(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


_lock = threading.RLock()
_login = None
_player = None
_retry_after = 0.0          # don't hammer Spotify after a failed player start
_last_error = ""
_cache = {"t": 0.0, "dump": None}
CACHE_SECONDS = 1.5


def _note(exc):
    global _last_error
    _last_error = f"{type(exc).__name__}: {str(exc)[:200]}"
    app.logger.warning("SpotAPI problem: %s", _last_error)


def _get_login():
    global _login
    if _login is not None:
        return _login
    raw = os.environ.get("SPOTAPI_COOKIE_DUMP", "").strip()
    if not raw:
        raise PlayerUnavailable(503, "SPOTAPI_COOKIE_DUMP isn't set on the server.")
    try:
        dump = json.loads(raw)
        if not isinstance(dump, dict) or not dump.get("identifier") or not dump.get("cookies"):
            raise ValueError("needs identifier and cookies")
        from spotapi import Config, Login
        from spotapi.utils.logger import NoopLogger
        lg = Login.from_cookies(dump, Config(logger=NoopLogger()))
        if not lg.logged_in:
            raise ValueError("cookie session not accepted")
    except Exception as exc:
        _note(exc)
        raise PlayerUnavailable(503, "SPOTAPI_COOKIE_DUMP is invalid or the cookie was rejected. Check /login-check.") from exc
    _login = lg
    return _login


def _get_player():
    global _player, _retry_after
    if _player is not None:
        return _player
    if time.time() < _retry_after:
        raise PlayerUnavailable(404, "No active Spotify device. Open the Spotify app and start any song, then press Refresh.")
    lg = _get_login()
    try:
        from spotapi import Player
        _player = Player(lg)  # needs a device that is currently active on the account
    except ValueError as exc:  # no active device
        _retry_after = time.time() + 5
        _note(exc)
        raise PlayerUnavailable(404, "No active Spotify device. Open the Spotify app and start any song, then press Refresh.") from exc
    except Exception as exc:
        _retry_after = time.time() + 5
        _note(exc)
        raise PlayerUnavailable(502, "Couldn't start the SpotAPI player. Check /login-check and the Render logs.") from exc
    return _player


def _drop_player():
    global _player
    _player = None
    _cache["t"] = 0.0


def _dump(p, fresh=False):
    """Spotify's connect-state snapshot (devices + player state), cached for a moment."""
    now = time.time()
    if fresh or now - _cache["t"] > CACHE_SECONDS or _cache["dump"] is None:
        p.renew_state()
        _cache.update(t=now, dump=p._device_dump)
    d = _cache["dump"] or {}
    active = d.get("active_device_id")
    if active:
        p.active_id = active  # follow the device the user is actually using
    return d


def spotify(fn, fresh=False):
    """Run fn(player, dump) under the lock and turn failures into JSON errors."""
    with _lock:
        try:
            p = _get_player()
            return fn(p, _dump(p, fresh))
        except PlayerUnavailable as e:
            return jsonify(error=e.message), e.status
        except Exception as exc:
            _note(exc)
            _drop_player()
            return jsonify(error="Spotify didn't accept that. Check /login-check."), 502


def _image(url):
    if not url:
        return None
    return "https://i.scdn.co/image/" + url.split(":")[-1] if url.startswith("spotify:image:") else url


@app.get("/devices")
@needs_login
def devices():
    def go(p, d):
        active = d.get("active_device_id")
        out = [{"id": k, "name": v.get("name", k), "type": v.get("device_type"), "is_active": k == active}
               for k, v in (d.get("devices") or {}).items()]
        return jsonify(devices=out)
    with _lock:
        try:
            p = _get_player()
        except PlayerUnavailable as e:
            return jsonify(devices=[], hint=e.message)
    return spotify(go)


@app.get("/state")
@needs_login
def state():
    def go(p, d):
        ps = d.get("player_state") or {}
        tr = ps.get("track") or {}
        md = tr.get("metadata") or {}
        if not tr.get("uri"):
            return jsonify(active=False)
        dur = int(ps.get("duration") or md.get("duration") or 0)
        pos = int(ps.get("position_as_of_timestamp") or 0)
        playing = bool(ps.get("is_playing")) and not ps.get("is_paused")
        try:
            skew = int(time.time() * 1000) - int(ps.get("timestamp") or 0)
        except (TypeError, ValueError):
            skew = 0
        if playing and 0 <= skew < 60000:
            pos += skew
        artists = [a.strip() for a in (md.get("artist_name") or "").split(",") if a.strip()]
        return jsonify(
            active=True,
            is_playing=playing,
            progress_ms=min(pos, dur) if dur else pos,
            device_id=d.get("active_device_id"),
            item={
                "uri": tr["uri"],
                "name": md.get("title") or tr["uri"],
                "artists": [{"name": a, "uri": ""} for a in artists],
                "album": {"name": md.get("album_title", ""), "uri": md.get("album_uri", "")},
                "duration_ms": dur,
                "image": _image(md.get("image_large_url") or md.get("image_url")),
            },
        )
    return spotify(go)


def _select_device(p, dev):
    if dev and dev != p.active_id:
        p.transfer_player(p.device_id, dev)
        p.active_id = dev


@app.post("/play")
@needs_login
def play():
    """Body: {"device_id": "...", "uris": ["spotify:track:..."]}. Only single tracks are supported here."""
    b = request.get_json(force=True, silent=True) or {}
    uris = b.get("uris") or []
    uri = uris[0] if uris else ""
    if not (isinstance(uri, str) and uri.startswith("spotify:track:") and len(uri.split(":")) == 3):
        return jsonify(error="Key-login mode can only play single tracks (not albums or playlists)."), 400

    def go(p, d):
        _select_device(p, b.get("device_id"))
        # SpotAPI can't start an arbitrary track directly, so queue it and skip to it.
        p.add_to_queue(uri)
        time.sleep(0.4)
        p.skip_next()
        _cache["t"] = 0.0
        return "", 204
    return spotify(go, fresh=True)


@app.post("/transport")
@needs_login
def transport():
    b = request.get_json(force=True, silent=True) or {}
    action = b.get("action")

    def go(p, d):
        if action == "pause":
            p.pause()
        elif action == "resume":
            p.resume()
        elif action == "next":
            p.skip_next()
        elif action == "prev":
            p.skip_prev()
        elif action == "seek":
            p.seek_to(max(0, int(b["position_ms"])))
        elif action == "volume":
            p.set_volume(min(1.0, max(0.0, float(b["volume"]))))
        elif action == "transfer":
            _select_device(p, b.get("device_id"))
        else:
            return jsonify(error="bad action"), 400
        _cache["t"] = 0.0
        return "", 204
    return spotify(go, fresh=True)


@app.get("/login-check")
def login_check():
    """Setup checklist. No secrets are shown."""
    cookie_ok = False
    try:
        cookie_ok = bool(json.loads(os.environ.get("SPOTAPI_COOKIE_DUMP", "") or "{}").get("cookies"))
    except Exception:
        pass
    lines = [
        f"SPINDLE_PLAYBACK_KEY set: {bool(env('SPINDLE_PLAYBACK_KEY'))}",
        f"SPOTAPI_COOKIE_DUMP parses and has cookies: {cookie_ok}",
        f"Player started: {_player is not None}",
    ]
    if logged_in():
        lines.append(f"Last SpotAPI problem: {_last_error or 'none'}")
    else:
        lines.append("Log in to see the last SpotAPI problem.")
    return "\n".join(lines), 200, {"Content-Type": "text/plain; charset=utf-8"}


# ---------- pages ----------

# Only these files are served (so app.py etc. can never be downloaded)
PUBLIC_FILES = {"index.html", "manifest.webmanifest", "sw.js", "icon-192.png", "icon-512.png", "spicetify-shim.js"}


def _file(name):
    resp = send_from_directory(BASE_DIR, name)
    if name in ("sw.js", "index.html"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/")
def index():
    return _file("index.html")


@app.get("/<path:name>")
def public_file(name):
    if name not in PUBLIC_FILES:
        abort(404)
    return _file(name)


# ---------- search by name (public) ----------
# SpotAPI first (no keys needed); the official API is only a fallback and
# needs SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET.

def _search_spotapi(query):
    from spotapi import Song
    raw = Song().query_songs(query, limit=10)
    out = []
    for entry in raw["data"]["searchV2"]["tracksV2"]["items"]:
        d = (entry.get("item") or entry).get("data") or {}
        uri = d.get("uri")
        if not uri:
            continue
        artists = ", ".join(
            (a.get("profile") or {}).get("name", "")
            for a in (d.get("artists") or {}).get("items", [])
        )
        album = d.get("albumOfTrack") or {}
        sources = (album.get("coverArt") or {}).get("sources") or [{}]
        out.append({
            "name": d.get("name", "Unknown"),
            "artists": artists,
            "uri": uri,
            "album": album.get("name", ""),
            "duration_ms": int(((d.get("duration") or {}).get("totalMilliseconds")) or 0),
            "image": sources[-1].get("url"),
        })
    return out


def _search_spotipy(query):
    from spotipy import Spotify
    from spotipy.oauth2 import SpotifyClientCredentials
    cid, secret = env("SPOTIFY_CLIENT_ID"), env("SPOTIFY_CLIENT_SECRET")
    if not (cid and secret):
        raise RuntimeError("Spotify client credentials not set")
    sp = Spotify(auth_manager=SpotifyClientCredentials(client_id=cid, client_secret=secret))
    items = sp.search(q=query, type="track", limit=10)["tracks"]["items"]
    return [
        {
            "name": t["name"],
            "artists": ", ".join(a["name"] for a in t["artists"]),
            "uri": t["uri"],
            "album": t["album"]["name"],
            "duration_ms": t["duration_ms"],
            "image": (t["album"]["images"] or [{}])[-1].get("url"),
        }
        for t in items
    ]


def search_tracks(query: str) -> list[dict]:
    last = None
    for fn in (_search_spotapi, _search_spotipy):
        try:
            return fn(query)
        except Exception as e:  # try the next backend
            app.logger.warning("%s failed: %r", fn.__name__, e)
            last = e
    raise RuntimeError(f"All search backends failed: {last!r}")


@app.get("/search")
def search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify(results=[])
    try:
        return jsonify(results=search_tracks(q))
    except Exception:
        return jsonify(error="Search is unavailable right now. Check the server logs."), 502


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 5000)), debug=True)
