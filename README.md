# Spindle

A Spotify web client (installable PWA) with a Marketplace for Spicetify-style extensions and color schemes.

## Setup (about 5 minutes)

1. **Host the folder over HTTPS.** Spotify requires an https redirect URI.
   Easiest: create a GitHub repo, upload these files, and turn on Settings > Pages (deploy from `main`, root).
   Your URL will look like `https://YOURNAME.github.io/REPO/`. Netlify Drop or Cloudflare Pages also work.
2. **Create a Spotify app** at https://developer.spotify.com/dashboard.
   Add the redirect URI shown in Spindle's Settings page (it is the exact address of the page, e.g. `https://YOURNAME.github.io/REPO/`).
   Select "Web API" (and "Web Playback SDK" if you want browser playback).
3. Open the hosted page on your phone, go to **Settings**, paste the **Client ID**, save, then **Sign in**.
4. In Chrome on Android, menu > **Install app** to put it on the home screen.
5. Start any song once in the official Spotify app so it shows up as a device, then pick it with the device button in Spindle.

## Notes

- Playback control needs **Spotify Premium** (Spotify's rule for the Web API player endpoints).
- Apps in Spotify development mode are limited to you plus users you add in the dashboard. Some endpoints can change or be restricted; errors show on screen.
- **Marketplace:** results are GitHub repos tagged `spicetify-extensions` or `spicetify-themes`. GitHub's unauthenticated limit is 60 requests/hour per IP; results are cached for 10 minutes.
- **Extensions** run in sandboxed iframes with a small `Spicetify` shim: `Player` (state, events, controls), `showNotification`, `LocalStorage`, `CosmosAsync` (api.spotify.com/v1 only), `Keyboard`, `Topbar.Button`, `Menu.Item`, `URI`, `addToQueue`.
  Extensions that depend on the desktop client's internals (React components, `Platform` APIs, `sp://` endpoints) will log an error and not work. The log is on Marketplace > Installed.
- **Themes:** only `color.ini` schemes are applied. Spicetify theme CSS targets the desktop app's markup and is not used.
- Extensions can still use the network and see what you play, so install only code you trust.
- Ad-blocking extensions are not supported (and are unnecessary with Premium).


## SpotAPI integration (backend required)

Spindle is a browser-based PWA, while SpotAPI is a Python library. The SpotAPI-powered catalog search runs in a Python backend. GitHub Pages only serves static files and cannot run Python, so the frontend and backend must be deployed separately. The frontend calls the backend URL configured in `config.js`.

### Deploy for the GitHub Pages website

1. Deploy the `spindle` folder as a Python web service on a host such as Render (the included `render.yaml` is a deployment blueprint). The service start command is `uvicorn server:app --host 0.0.0.0 --port $PORT`.
2. After deployment, copy the backend's public HTTPS URL.
3. Edit `config.js` in the GitHub repository and set `window.SPOTAPI_API_BASE` to that URL, for example `https://your-spindle-api.onrender.com` (no trailing slash). Commit and push the change.
4. Wait for GitHub Pages to redeploy, then reload the site. Test the backend directly at `https://YOUR-BACKEND/api/search?q=radiohead` first; it should return JSON.
5. If your backend URL changes, update `config.js`. The backend's `SPINDLE_ALLOWED_ORIGINS` environment variable must include `https://hexometry.github.io`.

Do not put passwords, cookies, or Spotify session tokens in `config.js` or in the GitHub repository. The current search endpoint is unauthenticated public catalog search only.

### Run locally

1. Install Python 3.10+.
2. From this folder, run `python -m pip install -r requirements.txt`.
3. Run `python -m uvicorn server:app --host 127.0.0.1 --port 8000`.
4. Open `http://127.0.0.1:8000`.

The adapter currently replaces **catalog track search** with SpotAPI. Spotify OAuth,
playback/device controls, user playlists and liked songs still use Spindle's existing
official Spotify Web API integration; those features need a separate server-side
SpotAPI mapping and authentication/session design before they can be safely migrated.
SpotAPI uses unofficial/private Spotify endpoints in parts, which may change or be
restricted. Do not expose an authenticated backend publicly without adding appropriate
session isolation, CSRF protections, rate limiting, and secret management.
