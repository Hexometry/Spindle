import os

from flask import Flask, jsonify, redirect, request, send_from_directory, session
from spotipy import Spotify, SpotifyException
from spotipy.cache_handler import FlaskSessionCacheHandler
from spotipy.oauth2 import SpotifyOAuth

app = Flask(__name__, static_folder="static")
app.secret_key = os.environ["FLASK_SECRET_KEY"]

SCOPES = " ".join([
    "streaming",                  # required for Web Playback SDK
    "user-read-email",            # required for Web Playback SDK
    "user-read-private",          # required for Web Playback SDK
    "user-read-playback-state",
    "user-modify-playback-state",
])


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
    am = auth_manager()
    info = am.validate_token(am.cache_handler.get_cached_token())
    return info["access_token"] if info else None


# ---------- pages & auth (Spotipy) ----------

@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/manifest.webmanifest")
def manifest():
    return send_from_directory(app.static_folder, "manifest.webmanifest")


@app.get("/sw.js")
def service_worker():
    # Served from the root so the worker can control the whole site
    resp = send_from_directory(app.static_folder, "sw.js")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/login")
def login():
    if not os.environ.get("SPOTIFY_CLIENT_ID"):
        return "Spotify login isn't configured.", 503
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
        {"name": t["name"], "artists": ", ".join(a["name"] for a in t["artists"]), "uri": t["uri"]}
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
