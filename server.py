"""Spindle backend powered by SpotAPI.

Configure SPOTIFY_COOKIE_DUMP with the JSON cookie/session dump described in
SpotAPI's README. Never expose this server to the public internet without TLS
and authentication: the configured session can control the Spotify account.
"""
from __future__ import annotations
import json, logging, os
from pathlib import Path
from typing import Any
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse
from spotapi import Song, PublicPlaylist

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("spindle")
app = FastAPI(title="Spindle SpotAPI adapter")
ROOT = Path(__file__).resolve().parent
song_api = Song()
_login = _player = _status = _private_playlist = None


def _cfg():
    from spotapi import Config, NoopLogger
    return Config(logger=NoopLogger())


def _get_login():
    global _login, _player, _status, _private_playlist
    if _login is not None and getattr(_login, "logged_in", False):
        return _login
    dump = os.getenv("SPOTIFY_COOKIE_DUMP", "").strip()
    if not dump:
        raise HTTPException(401, "SpotAPI session is not configured. Set SPOTIFY_COOKIE_DUMP to your own SpotAPI cookie dump.")
    try:
        from spotapi import Login, Player, PlayerStatus, PrivatePlaylist
        _login = Login.from_cookies(json.loads(dump), _cfg())
        if not getattr(_login, "logged_in", False):
            raise ValueError("The configured Spotify cookie session is not logged in or has expired.")
        _player = Player(_login)
        _status = PlayerStatus(_login)
        _private_playlist = PrivatePlaylist(_login)
        return _login
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Could not initialize SpotAPI session")
        raise HTTPException(401, "SpotAPI could not load the configured session. Refresh the cookie dump and restart the server.") from exc


def _value(obj, *names, default=None):
    for name in names:
        if isinstance(obj, dict) and name in obj: return obj[name]
        if hasattr(obj, name): return getattr(obj, name)
    return default


def _norm_track(item: dict[str, Any] | None):
    if not item: return None
    data = item.get("item", {}).get("data", item)
    if not isinstance(data, dict): return None
    uri = data.get("uri") or ("spotify:track:" + str(data["id"]) if data.get("id") else None)
    if not uri: return None
    artist_items = (data.get("artists") or {}).get("items", [])
    artists = []
    for a in artist_items:
        profile = a.get("profile") or a.get("data", {}).get("profile") or {}
        name = profile.get("name") or a.get("name")
        if name: artists.append({"name": name})
    album = data.get("albumOfTrack") or data.get("album") or {}
    cover = album.get("coverArt") or {}
    images = [{"url": s["url"], "width": s.get("width"), "height": s.get("height")} for s in cover.get("sources", []) if s.get("url")]
    dur = data.get("duration") or {}
    return {"id": data.get("id") or uri.rsplit(":",1)[-1], "uri": uri, "type":"track", "name":data.get("name", "Unknown track"), "artists":artists, "album":{"name":album.get("name", ""), "images":images}, "duration_ms":int((dur.get("totalMilliseconds",0) if isinstance(dur,dict) else 0) or 0)}


def _norm_album(item):
    data = item.get("item",{}).get("data",item) if isinstance(item,dict) else {}
    uri = data.get("uri")
    if not uri and data.get("id"): uri = "spotify:album:"+data["id"]
    if not uri: return None
    cover = data.get("coverArt") or data.get("cover") or {}
    images = [{"url":s["url"]} for s in cover.get("sources",[]) if s.get("url")]
    artists=[]
    for a in (data.get("artists") or {}).get("items",[]):
        name=((a.get("profile") or {}).get("name") or a.get("name"))
        if name: artists.append({"name":name})
    return {"id":data.get("id",uri.rsplit(":",1)[-1]),"uri":uri,"type":"album","name":data.get("name","Unknown album"),"artists":artists,"images":images}


def _norm_playlist(item):
    data = item.get("item",{}).get("data",item) if isinstance(item,dict) else {}
    uri=data.get("uri")
    if not uri and data.get("id"): uri="spotify:playlist:"+data["id"]
    if not uri: return None
    owner=data.get("owner") or data.get("publisher") or {}
    owner_name=(owner.get("name") or (owner.get("username") if isinstance(owner,dict) else None) or "") if isinstance(owner,dict) else ""
    cover=data.get("images") or (data.get("coverArt") or {}).get("sources",[])
    images=[{"url":x.get("url")} for x in cover if isinstance(x,dict) and x.get("url")]
    return {"id":data.get("id",uri.rsplit(":",1)[-1]),"uri":uri,"type":"playlist","name":data.get("name","Untitled playlist"),"owner":{"display_name":owner_name},"images":images}


def _items(raw):
    if isinstance(raw,dict):
        for path in (("items",),("tracks", "items"),("data","items"),("data","playlistV2","content","items"),("data","libraryV3","items")):
            cur=raw
            for key in path:
                cur=cur.get(key,{}) if isinstance(cur,dict) else {}
            if isinstance(cur,list): return cur
    return []

@app.get("/api/status")
def status():
    try:
        _get_login(); return {"authenticated": True}
    except HTTPException as exc:
        if exc.status_code == 401: return {"authenticated": False, "message": str(exc.detail)}
        raise

@app.get("/api/search")
def search(q: str = Query(min_length=1, max_length=200)):
    try:
        raw=song_api.query_songs(q,limit=20)
        root=raw.get("data",{}).get("searchV2",{})
        tracks=[t for t in (_norm_track(x) for x in root.get("tracksV2",{}).get("items",[])) if t]
        albums=[a for a in (_norm_album(x) for x in root.get("albumsV2",{}).get("items",[])) if a]
        playlists=[p for p in (_norm_playlist(x) for x in root.get("playlists",{}).get("items",[])) if p]
        return {"tracks":{"items":tracks},"albums":{"items":albums},"playlists":{"items":playlists}}
    except Exception as exc:
        log.exception("SpotAPI search failed"); raise HTTPException(502,"SpotAPI search failed; check backend logs.") from exc

@app.get("/api/me/playlists")
def playlists(limit:int=50):
    try:
        login=_get_login(); raw=_private_playlist.get_library(max(1,min(limit,100)))
        return {"items":[p for p in (_norm_playlist(x) for x in _items(raw)) if p],"next":None}
    except HTTPException: raise
    except Exception as exc:
        log.exception("SpotAPI library lookup failed"); raise HTTPException(502,"Could not load your library through SpotAPI.") from exc

@app.get("/api/me/tracks")
def liked_tracks(limit:int=50,offset:int=0):
    try:
        _get_login(); raw=_private_playlist.get_saved_tracks_info(limit=max(1,min(limit,100)),offset=max(0,offset))
        source=_items(raw); tracks=[]
        for x in source:
            x=x.get("track") or x.get("item") or x
            t=_norm_track(x)
            if t: tracks.append({"track":t})
        return {"items":tracks,"next":bool(len(tracks)>=limit)}
    except HTTPException: raise
    except Exception as exc:
        log.exception("SpotAPI liked tracks lookup failed"); raise HTTPException(502,"Could not load liked songs through SpotAPI.") from exc

@app.get("/api/playlists/{playlist_id}/items")
def playlist_items(playlist_id:str,limit:int=100,offset:int=0):
    try:
        raw=PublicPlaylist(playlist_id).get_playlist_info(limit=max(1,min(limit,100)),offset=max(0,offset))
        out=[]
        for x in _items(raw):
            track=x.get("item") or x.get("track") or x
            t=_norm_track(track)
            if t: out.append({"item":t})
        return {"items":out,"next":bool(len(out)>=limit)}
    except Exception as exc:
        log.exception("SpotAPI playlist lookup failed"); raise HTTPException(502,"Could not load this playlist through SpotAPI.") from exc


@app.get("/api/me/player/devices")
def player_devices():
    try:
        _get_login(); ids = _status.device_ids()
        if isinstance(ids, dict): raw = ids.get("devices", ids.get("items", []))
        else: raw = ids if isinstance(ids, list) else _value(ids, "devices", "items", default=[])
        devices=[]
        for d in raw or []:
            did=_value(d,"id","device_id",default=None)
            if did: devices.append({"id":did,"name":_value(d,"name",default="Spotify device"),"type":_value(d,"type",default="unknown"),"is_active":bool(_value(d,"is_active","active",default=False))})
        return {"devices":devices}
    except HTTPException: raise
    except Exception as exc:
        log.exception("SpotAPI device lookup failed"); raise HTTPException(502,"Could not list Spotify devices through SpotAPI.") from exc

@app.get("/api/player/state")
def player_state():
    try:
        _get_login(); _status.renew_state(); state=_status.state()
        item=_value(state,"item","track",default=None)
        track=_norm_track(item) if isinstance(item,dict) else None
        if track is None and item is not None:
            track={"uri":_value(item,"uri",default=""),"id":_value(item,"id",default=""),"name":_value(item,"name",default=""),"artists":[],"album":{"images":[]},"duration_ms":int(_value(item,"duration_ms","duration",default=0) or 0)}
        return {"item":track,"is_playing":bool(_value(state,"is_playing","playing",default=False)),"progress_ms":int(_value(state,"progress_ms","position_ms","progress",default=0) or 0),"shuffle_state":bool(_value(state,"shuffle_state","shuffle",default=False)),"repeat_state":_value(state,"repeat_state","repeat",default="off"),"device":None}
    except HTTPException: raise
    except Exception as exc:
        log.exception("SpotAPI player status failed"); raise HTTPException(502,"Could not read playback state through SpotAPI.") from exc

@app.post("/api/player/command")
async def player_command(request:Request):
    try:
        _get_login(); data=await request.json(); op=data.get("op"); body=data.get("body") or {}; query=data.get("query") or {}
        if op=="play":
            uris=body.get("uris") or []
            if uris: _player.play_track(uris[0], body.get("context_uri", ""))
            elif body.get("context_uri"):
                uri=body["context_uri"]
                _player.run_command(_status.active_device_id(),_status.active_device_id(),"play " + uri)
            else: _player.resume()
        elif op=="pause": _player.pause()
        elif op=="next": _player.skip_next()
        elif op=="previous": _player.skip_prev()
        elif op=="seek": _player.seek_to(int(query.get("position_ms",0)))
        elif op=="volume": _player.set_volume(max(0,min(1,float(query.get("volume_percent",50))/100)))
        elif op=="repeat": _player.repeat_track(str(query.get("state","off"))!="off")
        elif op=="queue": _player.add_to_queue(str(query.get("uri","")))
        elif op=="shuffle": raise HTTPException(501,"Shuffle control is not exposed by the current SpotAPI Player API.")
        elif op=="transfer": _player.transfer_player(_status.active_device_id(),str((body.get("device_ids") or [""])[0]))
        else: raise HTTPException(501,"This command is not supported by SpotAPI.")
        return {"ok":True}
    except HTTPException: raise
    except Exception as exc:
        log.exception("SpotAPI player command failed"); raise HTTPException(502,"SpotAPI could not perform this playback command.") from exc

@app.get("/")
def index(): return FileResponse(ROOT/"index.html")
for asset in ("app.js","style.css","manifest.webmanifest","icon-192.png","icon-512.png","sw.js"):
    @app.get(f"/{asset}")
    def static_asset(asset:str=asset): return FileResponse(ROOT/asset)
