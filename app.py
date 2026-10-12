import os

import requests

from flask import Flask, abort, jsonify, redirect, request, send_from_directory, session
from spotipy import Spotify, SpotifyException
from spotipy.cache_handler import FlaskSessionCacheHandler
from spotipy.oauth2 import SpotifyOAuth

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=None)  # no folders: files sit next to app.py
app.secret_key = os.environ["FLASK_SECRET_KEY"]

SCOPES = " ".join([
    "streaming",                  # required for Web Playback SDK
    "user-read-email",            # required for Web Playback SDK
    "user-read-private",          # required for Web Playback SDK
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-library-read",          # lets Spicetify-style extensions read your library
    "playlist-read-private",
])


REQUIRED_SPOTIFY_VARS = ("SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_REDIRECT_URI")


def missing_spotify_vars():
    return [v for v in REQUIRED_SPOTIFY_VARS if not os.environ.get(v)]


def auth_manager():
    # Tokens live in the Flask session cookie, so each visitor has their own login.
    return SpotifyOAuth(
        client_id=os.environ["SPOTIFY_CLIENT_ID"],
        client_secret=os.environ["SPOTIFY_CLIENT_SECRET"],
        redirect_uri=os.environ["SPOTIFY_REDIRECT_URI"],  # e.g. https://spindle.onrender.com/callback
        scope=SCOPES,
        cache_handler=FlaskSessionCacheHandler(session),
        show_dialog=False,
    )


def valid_token():
    """Return a valid access token (auto-refreshed by Spotipy) or None."""
    if missing_spotify_vars():
        return None
    am = auth_manager()
    info = am.validate_token(am.cache_handler.get_cached_token())
    return info["access_token"] if info else None


# ---------- pages & auth (Spotipy) ----------

# Only these files are served (so app.py etc. can never be downloaded)
PUBLIC_FILES = {"index.html", "manifest.webmanifest", "sw.js", "icon-192.png", "icon-512.png", "spicetify-shim.js"}


def _file(name):
    resp = send_from_directory(BASE_DIR, name)
    if name == "sw.js":
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


@app.get("/login")
def login():
    missing = missing_spotify_vars()
    if missing:
        return "Spotify login isn't set up yet. Missing environment variable(s) on the server: " + ", ".join(missing), 503
    return redirect(auth_manager().get_authorize_url())


@app.get("/callback")
def callback():
    if "code" not in request.args:
        return f"Spotify login failed: {request.args.get('error', 'no code')}", 400
    auth_manager().get_access_token(request.args["code"], check_cache=False)
    return redirect("/")


@app.get("/token")
def token():
    """The browser player calls this whenever the SDK needs a fresh token."""
    t = valid_token()
    if not t:
        return jsonify(error="not_logged_in"), 401
    return jsonify(token=t)


# ---------- playback control (Spotipy) ----------

@app.post("/play")
def play():
    """
    Body: {"device_id": "...", "uris": ["spotify:track:..."]}
       or {"device_id": "...", "context_uri": "spotify:album:..."}
    """
    if not valid_token():
        return jsonify(error="not_logged_in"), 401
    body = request.get_json(force=True)
    if not body.get("device_id"):
        return jsonify(error="device_id required"), 400

    sp = Spotify(auth_manager=auth_manager())
    try:
        sp.start_playback(
            device_id=body["device_id"],
            uris=body.get("uris"),
            context_uri=body.get("context_uri"),
            offset=body.get("offset"),
        )
    except SpotifyException as e:
        return jsonify(error=e.msg), e.http_status
    return "", 204


# ---------- account, devices, state, transport, API proxy ----------

def _spotify_call(fn):
    if not valid_token():
        return jsonify(error="not_logged_in"), 401
    try:
        return fn(Spotify(auth_manager=auth_manager()))
    except SpotifyException as e:
        return jsonify(error=e.msg), e.http_status


@app.get("/me")
def me():
    if not valid_token():
        return jsonify(logged_in=False)

    def go(sp):
        u = sp.current_user()
        return jsonify(logged_in=True, name=u.get("display_name") or u["id"], product=u.get("product"))
    return _spotify_call(go)


@app.get("/logout")
def logout():
    session.clear()
    return redirect("/")


@app.get("/devices")
def devices():
    return _spotify_call(lambda sp: jsonify(devices=sp.devices().get("devices", [])))


@app.get("/state")
def state():
    def go(sp):
        pb = sp.current_playback()
        if not pb or not pb.get("item"):
            return jsonify(active=False)
        t = pb["item"]
        album = t.get("album") or {}
        return jsonify(
            active=True,
            is_playing=pb["is_playing"],
            progress_ms=pb.get("progress_ms") or 0,
            device_id=(pb.get("device") or {}).get("id"),
            item={
                "uri": t["uri"],
                "name": t["name"],
                "artists": [{"name": a["name"], "uri": a["uri"]} for a in t.get("artists", [])],
                "album": {"name": album.get("name", ""), "uri": album.get("uri", "")},
                "duration_ms": t.get("duration_ms", 0),
                "image": (album.get("images") or [{}])[0].get("url"),
            },
        )
    return _spotify_call(go)


@app.post("/transport")
def transport():
    b = request.get_json(force=True)
    action, dev = b.get("action"), b.get("device_id")

    def go(sp):
        if action == "pause":
            sp.pause_playback(device_id=dev)
        elif action == "resume":
            sp.start_playback(device_id=dev)
        elif action == "next":
            sp.next_track(device_id=dev)
        elif action == "prev":
            sp.previous_track(device_id=dev)
        elif action == "seek":
            sp.seek_track(int(b["position_ms"]), device_id=dev)
        elif action == "transfer":
            sp.transfer_playback(dev, force_play=True)
        else:
            return jsonify(error="bad action"), 400
        return "", 204
    return _spotify_call(go)


@app.get("/api")
def api_proxy():
    """Read-only passthrough to the Spotify Web API (used by Spicetify's CosmosAsync.get)."""
    path = request.args.get("path", "")
    t = valid_token()
    if not t:
        return jsonify(error="not_logged_in"), 401
    if not path.startswith("/v1/") or ".." in path or "//" in path:
        return jsonify(error="unsupported path"), 400
    r = requests.get("https://api.spotify.com" + path, headers={"Authorization": f"Bearer {t}"}, timeout=10)
    return r.content, r.status_code, {"Content-Type": r.headers.get("Content-Type", "application/json")}


# ---------- search by name ----------
# Two backends, tried in order. Both return [{"name","artists","uri"}].
#  - spotipy: official API, app-level login (no user login needed). Needs
#             SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET.
#  - spotapi: unofficial web-player endpoints. No keys, but it breaks
#             sometimes and may be blocked from datacenter IPs like Render's.
# Set SEARCH_BACKEND=spotapi to try SpotAPI first.

def _search_spotipy(query):
    from spotipy.oauth2 import SpotifyClientCredentials
    cid, secret = os.environ.get("SPOTIFY_CLIENT_ID"), os.environ.get("SPOTIFY_CLIENT_SECRET")
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
        out.append({"name": d.get("name", "Unknown"), "artists": artists, "uri": uri})
    return out


def search_tracks(query: str) -> list[dict]:
    order = [_search_spotapi, _search_spotipy] if os.environ.get("SEARCH_BACKEND") == "spotapi" \
        else [_search_spotipy, _search_spotapi]
    last = None
    for fn in order:
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
