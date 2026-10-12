# Spindle SpotAPI playback patch

This is a **backend patch package**, not a full export of the GitHub Pages website. It includes an updated `server.py` based on the public repository and a deployment guide. The existing `/api/search` behavior is retained.

## What's included
- Existing SpotAPI catalog search endpoint (`GET /api/search?q=...`)
- Protected playback-control routes:
  - `POST /api/playback/pause`
  - `POST /api/playback/resume`
  - `POST /api/playback/next`
  - `POST /api/playback/previous`
  - `POST /api/playback/seek` with JSON `{"position_ms": 30000}`
  - `POST /api/playback/volume` with JSON `{"volume": 0.5}`
  - `POST /api/playback/play` with JSON `{"track":"spotify:track:...","playlist":"spotify:playlist:..."}`

## Render environment variables
Keep these in Render's Environment settings, never in GitHub:
- `SPINDLE_ALLOWED_ORIGINS=https://hexometry.github.io`
- `SPINDLE_PLAYBACK_KEY` = a long random secret
- `SPOTAPI_COOKIE_DUMP` = JSON session dump in the format described below

Example shape only (do not use these placeholder values):
`{"identifier":"your-account-email","cookies":{"sp_dc":"YOUR_COOKIE_VALUE"}}`

SpotAPI's documentation says cookie sessions are loaded through `Login.from_cookies(dump, cfg)`. The precise cookie keys depend on what your browser exported and SpotAPI's installed version. Never paste your cookie values into chat or commit them.

## Deploy
1. Download your current repository as a ZIP from GitHub or keep a local copy.
2. Replace its `server.py` with the one in this patch.
3. Commit the replacement to GitHub; Render should redeploy automatically.
4. Confirm `https://spindle-gn1o.onrender.com/api/search?q=radiohead` still returns JSON.
5. Configure the Render environment variables before testing playback.

## Calling a protected playback route
Use the secret key as a Bearer token. Example:
```js
await fetch('https://spindle-gn1o.onrender.com/api/playback/pause', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + playbackKey,
    'Content-Type': 'application/json'
  },
  body: '{}'
});
```

**Security warning:** do not put `SPINDLE_PLAYBACK_KEY` in public `config.js` or browser JavaScript on GitHub Pages. A key sent by a public static frontend is visible to users and is not a safe authentication boundary. This patch protects routes against casual unauthenticated access, but the key must be supplied through a private/session-aware backend flow before exposing controls to the public browser. Do not use these routes as a public service.

## Important limitations
- This patch adds backend commands; it does not yet wire the existing player buttons in `app.js` to these endpoints.
- `play_track` in the documented SpotAPI API requires both a track URI and a playlist URI.
- SpotAPI player controls are remote player controls, not a browser audio stream. This will not automatically create in-browser playback or guarantee that a device is active.
- SpotAPI uses unofficial/private endpoints in parts and may change. Test with a non-critical session first.
