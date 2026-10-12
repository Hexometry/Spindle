"""Small SpotAPI adapter for Spindle's browser UI.

Run with: python -m pip install -r requirements.txt && uvicorn server:app --host 127.0.0.1 --port 8000
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from spotapi import Song

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("spindle")
app = FastAPI(title="Spindle SpotAPI adapter")
# GitHub Pages is a different origin from the API host. Configure allowed origins
# via SPINDLE_ALLOWED_ORIGINS, comma-separated, for production.
import os
_allowed_origins = [x.strip() for x in os.getenv(
    "SPINDLE_ALLOWED_ORIGINS", "https://hexometry.github.io"
).split(",") if x.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["Accept", "Content-Type"],
)
song_api = Song()
ROOT = Path(__file__).resolve().parent

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
    try:
        raw = song_api.query_songs(q, limit=20)
        items = raw.get("data", {}).get("searchV2", {}).get("tracksV2", {}).get("items", [])
        tracks = [track for track in (normalize_track(x) for x in items) if track]
        # Keep the same response envelope the existing UI expects.
        return {"tracks": {"items": tracks}, "albums": {"items": []}, "playlists": {"items": []}}
    except Exception as exc:
        log.exception("SpotAPI search failed")
        raise HTTPException(status_code=502, detail="SpotAPI could not complete the search. Check backend logs.") from exc

@app.get("/")
def index():
    return FileResponse(ROOT / "index.html")

# Serve the remaining PWA assets from the same origin as the API adapter.
for asset in ("app.js", "style.css", "manifest.webmanifest", "icon-192.png", "icon-512.png", "sw.js"):
    @app.get(f"/{asset}")
    def static_asset(asset: str = asset):
        return FileResponse(ROOT / asset)
