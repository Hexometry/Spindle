"""Spindle SpotAPI adapter with catalog search and optional authenticated playback controls.

Keep Spotify cookies and SPINDLE_PLAYBACK_KEY in Render environment variables only.
Never commit either secret to GitHub.
"""
from __future__ import annotations

import json
import logging
import os
import secrets
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from spotapi import Song

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("spindle")
app = FastAPI(title="Spindle SpotAPI adapter")

_allowed_origins = [
    x.strip() for x in os.getenv(
        "SPINDLE_ALLOWED_ORIGINS", "https://hexometry.github.io"
    ).split(",") if x.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Accept", "Content-Type", "Authorization"],
)

song_api = Song()
ROOT = Path(__file__).resolve().parent
_player = None


def normalize_track(item: dict[str, Any]) -> dict[str, Any] | None:
    """Convert SpotAPI's searchV2 result into the track shape Spindle renders."""
    try:
        data = item.get("item", {}).get("data", item)
        if not data or not data.get("uri"):
            return None
        artists = []
        artist_items = (data.get("artists") or {}).get("items") or []
        for artist in artist_items:
            profile = artist.get("profile") or artist.get("data", {}).get("profile") or {}
            name = profile.get("name") or artist.get("name")
            if name:
                artists.append({"name": name})
        cover = (data.get("albumOfTrack") or data.get("album") or {}).get("coverArt") or {}
        images = [
            {"url": source["url"], "width": source.get("width"), "height": source.get("height")}
            for source in cover.get("sources", []) if source.get("url")
        ]
        duration = data.get("duration") or {}
        duration_ms = duration.get("totalMilliseconds", 0) if isinstance(duration, dict) else 0
        return {
            "id": data.get("id") or data["uri"].rsplit(":", 1)[-1],
            "uri": data["uri"],
            "type": "track",
            "name": data.get("name", "Unknown track"),
            "artists": artists,
            "album": {"images": images},
            "duration_ms": int(duration_ms or 0),
        }
    except (AttributeError, KeyError, TypeError, ValueError):
        return None


@app.get("/api/search")
def search(q: str = Query(min_length=1, max_length=200)):
    """Existing public catalog search; kept independent from playback auth."""
    try:
        raw = song_api.query_songs(q, limit=20)
        items = raw.get("data", {}).get("searchV2", {}).get("tracksV2", {}).get("items", [])
        tracks = [track for track in (normalize_track(x) for x in items) if track]
        return {"tracks": {"items": tracks}, "albums": {"items": []}, "playlists": {"items": []}}
    except Exception as exc:
        log.exception("SpotAPI search failed")
        raise HTTPException(
            status_code=502,
            detail="SpotAPI could not complete the search. Check backend logs."
        ) from exc


def _require_playback_key(authorization: str | None) -> None:
    expected = os.getenv("SPINDLE_PLAYBACK_KEY", "")
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="Playback is not configured. Set SPINDLE_PLAYBACK_KEY in Render."
        )
    supplied = (authorization or "").removeprefix("Bearer ").strip()
    if not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Invalid playback key.")


def _get_player():
    """Load a SpotAPI Player from a cookie dump held in Render env vars.

    SPOTAPI_COOKIE_DUMP must be JSON with an identifier and cookies, e.g.
    {"identifier":"your-account-email","cookies":{"sp_dc":"...","sp_key":"..."}}
    Exact cookie-dump requirements can vary by SpotAPI version.
    """
    global _player
    if _player is not None:
        return _player
    raw_dump = os.getenv("SPOTAPI_COOKIE_DUMP", "")
    if not raw_dump:
        raise HTTPException(
            status_code=503,
            detail="Playback is not configured. Set SPOTAPI_COOKIE_DUMP in Render."
        )
    try:
        from spotapi import Config, Login, Player
        dump = json.loads(raw_dump)
        if not isinstance(dump, dict) or not dump.get("identifier") or not dump.get("cookies"):
            raise ValueError("Cookie dump must contain identifier and cookies.")
        cfg = Config()
        login = Login.from_cookies(dump, cfg)
        if not login.logged_in:
            raise ValueError("SpotAPI did not accept the saved cookie session.")
        _player = Player(login)
        return _player
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("SpotAPI playback session initialization failed")
        raise HTTPException(
            status_code=503,
            detail="SpotAPI playback session could not initialize. Check cookie-dump format and Render logs."
        ) from exc


@app.post("/api/playback/{action}")
def playback_action(
    action: str,
    authorization: str | None = Header(default=None),
    payload: dict[str, Any] | None = None,
):
    """Protected SpotAPI player commands. This does not return an audio stream."""
    _require_playback_key(authorization)
    player = _get_player()
    payload = payload or {}
    try:
        if action == "pause":
            player.pause()
        elif action == "resume":
            player.resume()
        elif action == "next":
            player.skip_next()
        elif action == "previous":
            player.skip_prev()
        elif action == "seek":
            position_ms = int(payload.get("position_ms", -1))
            if position_ms < 0:
                raise HTTPException(status_code=400, detail="position_ms must be zero or greater.")
            player.seek_to(position_ms)
        elif action == "volume":
            volume = float(payload.get("volume", -1))
            if not 0 <= volume <= 1:
                raise HTTPException(status_code=400, detail="volume must be between 0 and 1.")
            player.set_volume(volume)
        elif action == "play":
            track = str(payload.get("track", ""))
            playlist = str(payload.get("playlist", ""))
            if not track.startswith("spotify:track:") or not playlist.startswith("spotify:playlist:"):
                raise HTTPException(
                    status_code=400,
                    detail="play requires Spotify track and playlist URIs. A playlist URI is required by SpotAPI."
                )
            player.play_track(track, playlist)
        else:
            raise HTTPException(status_code=404, detail="Unknown playback action.")
        return {"ok": True, "action": action}
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("SpotAPI playback command failed: %s", action)
        raise HTTPException(status_code=502, detail="SpotAPI playback command failed; check Render logs.") from exc


@app.get("/")
def index():
    index_file = ROOT / "index.html"
    if not index_file.exists():
        return {"ok": True, "service": "Spindle SpotAPI adapter"}
    return FileResponse(index_file)


for asset in ("app.js", "style.css", "manifest.webmanifest", "icon-192.png", "icon-512.png", "sw.js", "config.js"):
    @app.get(f"/{asset}")
    def static_asset(asset: str = asset):
        asset_path = ROOT / asset
        if not asset_path.exists():
            raise HTTPException(status_code=404, detail="Asset not found.")
        return FileResponse(asset_path)
