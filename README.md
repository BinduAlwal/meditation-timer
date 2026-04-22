# Meditation Timer — PWA

A simple interval meditation timer. Builds custom sessions with named
intervals, plays a chime at each transition, saves sessions you can reload
later, and works offline once installed.

Pure web — no build step, no framework, no dependencies. Just static
files served from any HTTP host.

## Files

```
meditation-timer/
├── index.html           # App UI
├── app.js               # Timer logic + session management
├── styles.css           # Styling
├── manifest.webmanifest # PWA manifest
├── sw.js                # Service worker (offline support)
├── audio/               # Chime WAV files
│   ├── bell.wav
│   ├── bowl.wav
│   ├── gong.wav
│   └── wood.wav
├── icons/               # PWA + iOS icons
│   ├── icon-180.png            (iOS home screen)
│   ├── icon-192.png            (Android / PWA)
│   ├── icon-512.png            (PWA splash)
│   ├── icon-192-maskable.png   (Android adaptive icon)
│   └── icon-512-maskable.png   (Android adaptive icon)
└── .github/workflows/
    └── deploy.yml       # Auto-deploy to GitHub Pages on push
```

## Run locally

You need any static file server (a service worker won't register from
`file://`). Easiest option:

```bash
cd meditation-timer
python3 -m http.server 8000
# or:  npx serve
```

Open http://localhost:8000. For the "Add to Home Screen" flow to work
on your phone, you need HTTPS — GitHub Pages gives you that automatically.

## Deploy to GitHub Pages

### One-time setup

1. Create a new GitHub repo (public is required for free GitHub Pages, or
   you need a Pro account for private repo Pages).
2. Push this folder to the repo:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```
3. In the repo on GitHub: **Settings → Pages → Build and deployment →
   Source: GitHub Actions**. (Not "Deploy from a branch" — we're using the
   Actions workflow in `.github/workflows/deploy.yml`.)
4. The workflow runs automatically on every push to `main`. You can watch
   it under the **Actions** tab. First deploy takes ~1 minute.

### Your site URL

`https://YOUR_USERNAME.github.io/YOUR_REPO/`

Every push to `main` redeploys. No build step — the site is the repo.

### Custom domain (optional)

1. Add a `CNAME` file at the repo root containing just your domain:
   ```
   meditation.example.com
   ```
2. Configure a CNAME DNS record for `meditation` pointing to
   `YOUR_USERNAME.github.io`.
3. In **Settings → Pages**, enter the custom domain and check "Enforce
   HTTPS" once the cert provisions (takes a few minutes).

## Add to home screen

### iPhone / iPad
1. Open the site in Safari
2. Tap the Share button
3. "Add to Home Screen"
4. Tap the new icon — launches fullscreen, no Safari chrome

### Android
Chrome offers an "Install" prompt automatically, or:
1. Menu (⋮) → "Install app" or "Add to Home screen"

### Desktop (Chrome / Edge)
1. Install icon appears in the address bar
2. Click it to install as a standalone app

## Features

### Timer
- Multiple named intervals with per-interval duration
- Four chime sounds: bell, singing bowl, gong, wood block
- Presets: 3-min breath, 10-min body scan, 20-min deep
- Adjustable volume, optional starting chime
- Pause, skip, stop
- Circular progress ring

### Sessions
- Save the current interval set with a custom name
- List of saved sessions, tap to reload, × to delete
- Dirty-state indicator when a loaded session has unsaved edits
- Saved to `localStorage` — persists across browser restarts but not
  across devices or browsers

### Web platform APIs used
- **Wake Lock API** — keeps the screen on during a session
  (Safari 16.4+, Chrome, most modern browsers)
- **Media Session API** — shows session metadata on the lock screen
  and wires play/pause/skip/stop to system media controls while audio
  is playing
- **Web Audio API** — WAV playback with a synth fallback
- **Service Worker** — caches the app shell for offline use
- **Vibration API** — haptic feedback on Android (iOS ignores)

## Known limitations (vs a native app)

- **Background audio**: browsers suspend audio when the tab is backgrounded
  or the phone is locked. A silent-audio trick helps with short locks
  (~30s) but not long ones. For long sessions with a locked screen, you
  want the native iOS build.
- **Lock-screen controls** only work while audio is actively playing.
  They won't be present during the silent part of an interval.
- **Apple Health integration**: not available from the web.
- **Notifications** when an interval ends while the tab is backgrounded:
  not currently wired. (Web Push exists for PWAs on iOS 16.4+ but
  requires a push server; not included here.)

## Adding cross-device session sync later

`app.js` has a `SessionStore` module with a swappable `backend` object.
To add iCloud / Supabase / Firebase sync, replace the `backend` object's
`readAll` / `writeAll` methods — the rest of the code doesn't change.
Each session carries `updatedAt` and `schemaVersion` which is what you
need for last-write-wins conflict resolution.

## License

MIT — use however you like.
