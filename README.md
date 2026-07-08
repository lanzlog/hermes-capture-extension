# Hermes Capture

A companion browser extension for the [Hermes HAR Recorder](https://github.com/lanzlog/hermes-har-recorder).

It lets Hermes **record a browser window/tab that is already open** — including
all its popups, redirects and newly-opened tabs — **without restarting the
browser**. This solves the limitation of the proxy approach (a proxy is only
read when a browser starts, and all Chrome profiles share one process, so you
can't proxy just one open window).

## How it works

```
┌─────────────────┐   WebSocket (localhost)   ┌──────────────────────┐
│ Hermes desktop  │ ◀───────────────────────▶ │ Hermes Capture ext.  │
│ app (Python)    │                            │ (background worker)  │
│  hermes_bridge  │   1. list open windows     │  chrome.debugger +   │
│                 │   2. start_capture(tab)    │  CDP Network domain  │
│  window picker  │   3. stream entries ◀──────│  attaches to a live  │
│  Pause/Continue │   4. pause/resume/stop     │  tab, follows popups │
└─────────────────┘                            └──────────────────────┘
```

The extension attaches Chrome's debugger to the chosen tab and streams every
request/response (headers + bodies) to the Hermes app over a localhost
WebSocket. Because `chrome.debugger` attaches to a **live** tab, it works on
windows that are already open.

## Features

- Lists every open window/tab, grouped per profile, in the Hermes app.
- Capture a specific already-open window/tab — no browser restart.
- Automatically follows popups, redirects and new tabs opened from the
  captured tab (e.g. login popup → OTP tab → dashboard).
- Pause / Continue capture from the Hermes app.
- Works in Chrome, Brave, Edge and other Chromium browsers.
- **Firefox is also supported** via a separate build in [`firefox/`](firefox/)
  (uses `webRequest` + `filterResponseData` instead of CDP). See
  [`docs/firefox.md`](docs/firefox.md).

## Install — Chrome / Brave / Edge (unpacked, for development)

1. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. **Install it in every profile** you want to capture (a,b,c,d…). Extensions
   are per-profile.
5. Click the Hermes Capture icon → confirm the **App port** matches the port
   in the Hermes app (default `8898`).

The extension icon shows a green badge (`on`) when it's connected to the app.

## Use

1. Start the Hermes desktop app (it hosts the bridge automatically).
2. In Hermes, the browser selector now lists **open windows** below
   "Open new window". Pick the window/tab you want.
3. Press a Record button. Only that window (and anything it spawns) is captured.
4. Use **Pause / Continue** to skip irrelevant activity; **Stop** when done.

> Note on the debugger banner: Chrome shows a *"Hermes Capture is debugging
> this browser"* bar on captured tabs. That's expected — it's how the extension
> reads the traffic. It disappears when you Stop.

## Install — Firefox (temporary, for development)

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `firefox/manifest.json`.
3. Click the toolbar icon → confirm the **App port** matches Hermes (`8898`).

Firefox only keeps *signed* add-ons across restarts; a temporary load is
cleared when you close Firefox. For a permanent install, sign the add-on via
AMO / `web-ext sign`. Full details in [`docs/firefox.md`](docs/firefox.md).
Firefox needs **no debugger banner** and **no mitmproxy CA** for this route.

## Integrating with the Hermes app

See [`bridge/hermes_bridge.py`](bridge/hermes_bridge.py) (the WebSocket server
the app hosts) and [`docs/integration.md`](docs/integration.md) for wiring it
into `gui_main.py`.

## Repo layout

```
manifest.json            MV3 manifest (Chromium)
src/background.js         service worker: WS + CDP capture + follow-new-tabs
src/protocol.js          shared protocol constants
src/popup.html/.js       small connection/status popup
firefox/manifest.json    MV2 manifest (Firefox)
firefox/background.js    Firefox capture: webRequest + filterResponseData
firefox/popup.html/.js   Firefox connection/status popup
firefox/icons/           Firefox extension icons
bridge/hermes_bridge.py  reference WebSocket server for the Hermes app
docs/integration.md      how to wire the bridge into the desktop app
docs/firefox.md          Firefox build details
icons/                   extension icons (Chromium)
```

## License

MIT — see [LICENSE](LICENSE).
