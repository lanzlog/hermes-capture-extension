# Firefox build

The Firefox extension lives in [`../firefox/`](../firefox/). Firefox has no
`chrome.debugger` / CDP for extensions, so the capture layer is different from
the Chromium build — but it talks to the Hermes desktop app over the **same**
localhost WebSocket + JSON protocol (see [`../src/protocol.js`](../src/protocol.js)),
so no changes are needed in the app.

## How it captures
- **Request line + body:** `webRequest.onBeforeRequest` (`requestBody`).
- **Request headers:** `webRequest.onSendHeaders`.
- **Response status + headers:** `webRequest.onHeadersReceived`.
- **Response body:** `browser.webRequest.filterResponseData(requestId)` — a
  Firefox-only API that streams the response bytes (Chromium removed this).
  We tee the bytes (pass them through untouched) and reconstruct the body,
  sending text as UTF-8 and binary as base64.
- **Completion / errors:** `onCompleted` / `onErrorOccurred`.

Only traffic from the tabs the user chose to capture is emitted (filtered by
`tabId`); popups / new tabs opened from a captured tab are auto-followed via
`tabs.onCreated` (openerTabId or same-window), matching the Chromium build.

## Emitted entry shape
Identical to the Chromium build, so the app's `entry_to_captured()` maps it
with no changes: `{requestId, method, url, requestHeaders, requestBody,
status, statusText, responseHeaders, responseBody, responseBase64, mimeType}`.

## Install (temporary / unsigned)
Firefox only loads signed extensions permanently. For development use a
**temporary** load (cleared on restart):
1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `firefox/manifest.json`
4. Click the toolbar icon → set **App port** to match the app (default 8898)

For a permanent install, package + sign the add-on via
[AMO / `web-ext sign`](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).
Firefox Developer Edition / Nightly can also disable signature enforcement
(`xpinstall.signatures.required = false` in `about:config`).

## HTTPS
Like the Chromium build, this reads decrypted traffic **inside** the browser,
so **no mitmproxy CA import is needed** for the extension capture route.

## Notes / limits
- Uses MV2 (`manifest_version: 2`) with a persistent background page — the
  supported combo for `webRequestBlocking` + `filterResponseData` in Firefox.
- `filterResponseData` can occasionally throw for some special request types
  (e.g. some cached / service-worker responses); those entries are still sent
  with headers/status but an empty body.
