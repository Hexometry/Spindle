# Spindle — SpotAPI edition

Spindle is a browser-based Spotify client/PWA with a Marketplace for Spicetify-style extensions and themes. Spotify catalog and account operations are routed through a local Python backend using [SpotAPI](https://github.com/Aran404/SpotAPI). The Spotify Developer Web API OAuth flow and Web Playback SDK are no longer used.

## Requirements

- Python 3.10+
- A Spotify account and a SpotAPI cookie/session dump for private account features
- Use only on a trusted machine/network. The backend can control the configured Spotify account.

## Install and run

```bash
python -m venv .venv
# Windows: .venv\\Scripts\\activate
# macOS/Linux:
source .venv/bin/activate
python -m pip install -r requirements.txt
```

Set `SPOTIFY_COOKIE_DUMP` to the JSON cookie/session dump for your own Spotify session, following SpotAPI's official README section **Import Cookies**. Keep this value private; do not commit it to Git or paste it into issues. For example, set it in your shell before starting the server:

```bash
# macOS/Linux; use a protected environment and your own dump
export SPOTIFY_COOKIE_DUMP='{"identifier":"YOUR_ACCOUNT_IDENTIFIER","cookies":{"sp_dc":"YOUR_PRIVATE_COOKIE"}}'
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

The example shows the shape only; use the complete valid cookie dump exported/prepared for your own session as described by SpotAPI. A cookie dump containing only one cookie may not be sufficient. On Windows PowerShell, set the variable with `$env:SPOTIFY_COOKIE_DUMP='...'` before running Uvicorn.

Open <http://127.0.0.1:8000>. Public song search can work without a private session; library and playback features require a valid session. The Settings page can test whether the backend session is configured.

## API migration status

- Catalog song search: SpotAPI `Song.query_songs`
- Public playlist lookup: SpotAPI `PublicPlaylist`
- Library and liked tracks: SpotAPI `PrivatePlaylist`
- Playback state/device listing: SpotAPI `PlayerStatus`
- Playback commands: SpotAPI `Player`
- OAuth tokens, `api.spotify.com/v1` requests, and Spotify Web Playback SDK: removed from the main application path

SpotAPI is based on Spotify's private/web endpoints and these can change or fail. Not every legacy extension API endpoint has an equivalent SpotAPI method. Unsupported extension calls will return an explicit error rather than silently call the old API. Shuffle and some context/device operations are not currently exposed by the SpotAPI methods used here. Please validate account and playback behavior with your own session before relying on this build.

## Security

The backend is bound to `127.0.0.1` by default. Do not expose it on a public interface without adding authentication, TLS, CSRF protection, and a deliberate session-management design. Treat Spotify cookie dumps as passwords. Do not commit them, serve them to the browser, or share them.

## Marketplace

Marketplace metadata is still retrieved from GitHub. Extensions are third-party code; install only extensions you trust. Extensions that call legacy Spotify Web API endpoints may need their own migration to the SpotAPI operations supported by this backend.
