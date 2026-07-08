# Firefox build (planned)

Firefox does not support `chrome.debugger` / the Chrome DevTools Protocol in
extensions. A Firefox build needs a different capture mechanism:

## Option A — `webRequest` + `webRequestBlocking` + `filterResponseData`
Firefox's `browser.webRequest.filterResponseData()` can read response bodies
(Chromium removed this). Combined with `onBeforeRequest` (request bodies) and
`onSendHeaders` / `onHeadersReceived` (headers), you can reconstruct full HAR
entries per tab. Filter by `tabId` to capture only the chosen window's tabs.

- Manifest: `manifest_version: 2` (or MV3 with `"browser_specific_settings"`),
  permissions `webRequest`, `webRequestBlocking`, `<all_urls>`, `tabs`.
- Reuse `src/protocol.js` and the same WebSocket bridge — only the capture
  layer differs. Refactor `background.js` so the WS/window-listing code is
  shared and the network-capture code is swappable.

## Option B — Firefox Remote Debugging Protocol
Connect to Firefox's remote debugging (RDP) from the app side instead of an
extension. More setup for the user; Option A is preferred.

## HTTPS
Both options read decrypted traffic inside the browser, so — unlike the proxy
path — **no mitmproxy CA import is needed** for the extension capture route.
This is a nice side benefit of the extension approach for Firefox users.

Tracking: keep the Chromium build (`manifest.json`) as the primary target;
add `manifest.firefox.json` + a `src/capture_firefox.js` when building this.
