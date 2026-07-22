// Hermes Capture — Firefox background script (MV2).
//
// Firefox has no chrome.debugger / CDP for extensions, so this build captures
// traffic with the WebExtensions webRequest API. The key advantage over
// Chromium here is browser.webRequest.filterResponseData(), which lets us read
// full response bodies (Chromium removed this). We reconstruct HAR-like
// entries and stream them to the Hermes desktop app over the same localhost
// WebSocket + JSON protocol used by the Chromium build (see ../src/protocol.js).
//
// Capturing an already-open tab works because webRequest observes live traffic
// from any tab — we simply filter by the tabIds the user chose to capture.

const DEFAULT_PORT = 8898;
const RECONNECT_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const PROTOCOL_VERSION = "fx-1.0";
const wsUrl = (port) => `ws://127.0.0.1:${port}/hermes`;

let ws = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_MS;
let connecting = false;

// tabIds we're actively capturing.
const capturedTabs = new Set();
let paused = false;
let followNew = true;

// Per-request scratch data keyed by requestId.
const pending = new Map();

// ─── WebSocket plumbing ─────────────────────────────────────────────────────
async function getPort() {
  const { hermesPort } = await browser.storage.local.get("hermesPort");
  return hermesPort || DEFAULT_PORT;
}

function isSocketLive() {
  return (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  );
}

async function connect() {
  clearTimeout(reconnectTimer);
  if (connecting || isSocketLive()) return;
  connecting = true;

  const port = await getPort();
  let socket;
  try {
    // Browser logs ERR_CONNECTION_REFUSED for failed localhost WS — cannot
    // silence. Exponential backoff (2s → 60s) cuts the spam while Hermes is down.
    socket = new WebSocket(wsUrl(port));
  } catch (e) {
    connecting = false;
    setBadge("…", "#E5C07B");
    scheduleReconnect();
    return;
  }

  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;
    connecting = false;
    reconnectDelay = RECONNECT_MS;
    send({ type: "hello", browser: "firefox", version: PROTOCOL_VERSION });
    reportWindows();
    setBadge("on", "#98C379");
  };
  socket.onmessage = (ev) => {
    if (ws !== socket) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleCommand(msg).catch((e) => send({ type: "error", message: String(e) }));
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    connecting = false;
    ws = null;
    setBadge("…", "#E5C07B");
    scheduleReconnect();
  };
  socket.onerror = () => {
    try { socket.close(); } catch {}
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(connect, delay);
}

function reconnectNow() {
  clearTimeout(reconnectTimer);
  reconnectDelay = RECONNECT_MS;
  connecting = false;
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  connect();
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setBadge(text, color) {
  browser.browserAction.setBadgeText({ text });
  if (color) browser.browserAction.setBadgeBackgroundColor({ color });
}

// ─── Window / tab listing ───────────────────────────────────────────────────
async function reportWindows() {
  const wins = await browser.windows.getAll({ populate: true });
  const windows = wins.map((w) => ({
    id: w.id,
    focused: w.focused,
    incognito: w.incognito,
    tabs: (w.tabs || []).map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      active: t.active,
      windowId: t.windowId,
      capturing: capturedTabs.has(t.id),
    })),
  }));
  send({ type: "windows", windows });
}

// ─── Command handling ───────────────────────────────────────────────────────
async function handleCommand(msg) {
  switch (msg.type) {
    case "list_windows":
      await reportWindows();
      break;
    case "start_capture":
      followNew = msg.followNew !== false;
      await startCapture(msg.tabId, msg.windowId);
      break;
    case "pause":
      paused = true;
      send({ type: "paused" });
      break;
    case "resume":
      paused = false;
      send({ type: "resumed" });
      break;
    case "stop_capture":
      await stopAll("user");
      break;
  }
}

// ─── Capture lifecycle ──────────────────────────────────────────────────────
async function startCapture(tabId, windowId) {
  paused = false;
  let tabIds = [];
  if (typeof tabId === "number") {
    tabIds = [tabId];
  } else if (typeof windowId === "number") {
    const tabs = await browser.tabs.query({ windowId });
    tabIds = tabs.map((t) => t.id);
  }
  tabIds.forEach((id) => capturedTabs.add(id));
  const info = tabIds.length ? await safeTab(tabIds[0]) : null;
  send({
    type: "capture_started",
    target: info
      ? { tabId: info.id, windowId: info.windowId, title: info.title, url: info.url }
      : { tabId, windowId },
  });
  reportWindows();
}

async function stopAll(reason) {
  capturedTabs.clear();
  pending.clear();
  paused = false;
  send({ type: "capture_stopped", reason: reason || "user" });
  reportWindows();
}

function isCaptured(tabId) {
  return tabId != null && tabId >= 0 && capturedTabs.has(tabId);
}

// ─── webRequest capture pipeline ────────────────────────────────────────────
// Request line + body.
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (paused || !isCaptured(details.tabId)) return {};
    const e = {
      tabId: details.tabId,
      requestId: details.requestId,
      startedDateTime: new Date(details.timeStamp).toISOString(),
      method: details.method,
      url: details.url,
      type: details.type || "",
      requestHeaders: {},
      requestBody: decodeRequestBody(details.requestBody),
      responseHeaders: {},
    };
    pending.set(details.requestId, e);

    // Stream the response body via filterResponseData (Firefox-only power).
    try {
      const filter = browser.webRequest.filterResponseData(details.requestId);
      const chunks = [];
      filter.ondata = (event) => {
        chunks.push(new Uint8Array(event.data));
        filter.write(event.data); // pass through untouched
      };
      filter.onstop = () => {
        const rec = pending.get(details.requestId);
        if (rec) rec._bodyBytes = concatChunks(chunks);
        filter.disconnect();
      };
      filter.onerror = () => { try { filter.disconnect(); } catch {} };
    } catch (err) {
      // filterResponseData can throw for some request types; ignore body then.
    }
    return {};
  },
  { urls: ["<all_urls>"] },
  ["blocking", "requestBody"]
);

// Request headers.
browser.webRequest.onSendHeaders.addListener(
  (details) => {
    if (paused || !isCaptured(details.tabId)) return;
    const e = pending.get(details.requestId);
    if (e) e.requestHeaders = headersToObject(details.requestHeaders);
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

// Response status + headers.
browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (paused || !isCaptured(details.tabId)) return;
    const e = pending.get(details.requestId);
    if (!e) return;
    e.status = details.statusCode;
    e.statusText = details.statusLine || "";
    e.responseHeaders = headersToObject(details.responseHeaders);
    e.mimeType = pickHeader(details.responseHeaders, "content-type");
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

browser.webRequest.onCompleted.addListener(
  (details) => finalize(details.requestId),
  { urls: ["<all_urls>"] }
);

browser.webRequest.onErrorOccurred.addListener(
  (details) => {
    const e = pending.get(details.requestId);
    if (e && isCaptured(details.tabId)) {
      e.error = details.error || "failed";
      emitEntry(e);
    }
    pending.delete(details.requestId);
  },
  { urls: ["<all_urls>"] }
);

function finalize(requestId) {
  const e = pending.get(requestId);
  if (!e) return;
  const bytes = e._bodyBytes;
  if (bytes && bytes.length) {
    const [body, base64] = bodyToTransport(bytes, e.mimeType || "");
    e.responseBody = body;
    e.responseBase64 = base64;
  } else {
    e.responseBody = "";
    e.responseBase64 = false;
  }
  delete e._bodyBytes;
  emitEntry(e);
  pending.delete(requestId);
}

function emitEntry(e) {
  if (paused) return;
  send({ type: "entry", entry: e });
}

// ─── Follow popups / new tabs from captured tabs ────────────────────────────
browser.tabs.onCreated.addListener(async (tab) => {
  if (!followNew || capturedTabs.size === 0) return;
  const opener = tab.openerTabId;
  if (opener && capturedTabs.has(opener)) {
    capturedTabs.add(tab.id);
    reportWindows();
    return;
  }
  // Same-window popups without an opener set.
  const capturedWindows = new Set();
  for (const id of capturedTabs) {
    const t = await safeTab(id);
    if (t) capturedWindows.add(t.windowId);
  }
  if (capturedWindows.has(tab.windowId)) {
    capturedTabs.add(tab.id);
    reportWindows();
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (capturedTabs.has(tabId)) {
    capturedTabs.delete(tabId);
    reportWindows();
  }
});

browser.tabs.onUpdated.addListener((_, info) => {
  if (info.status === "complete" || info.title) throttleReport();
});
browser.windows.onCreated.addListener(throttleReport);
browser.windows.onRemoved.addListener(throttleReport);

let reportTimer = null;
function throttleReport() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(reportWindows, 400);
}

// ─── Helpers ────────────────────────────────────────────────────────────────
async function safeTab(tabId) {
  try { return await browser.tabs.get(tabId); } catch { return null; }
}

function headersToObject(headers) {
  const out = {};
  for (const h of headers || []) out[h.name] = h.value ?? h.binaryValue ?? "";
  return out;
}

function pickHeader(headers, name) {
  const lc = name.toLowerCase();
  for (const h of headers || []) if (h.name.toLowerCase() === lc) return h.value || "";
  return "";
}

function decodeRequestBody(body) {
  if (!body) return "";
  if (body.formData) {
    try { return JSON.stringify(body.formData); } catch { return ""; }
  }
  if (body.raw && body.raw.length) {
    try {
      const parts = body.raw
        .filter((r) => r.bytes)
        .map((r) => new TextDecoder("utf-8").decode(new Uint8Array(r.bytes)));
      return parts.join("");
    } catch { return ""; }
  }
  return "";
}

function concatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// Decide whether to send a body as UTF-8 text or base64 (binary).
function bodyToTransport(bytes, mimeType) {
  const isText = /^(text\/|application\/(json|javascript|xml|xhtml|x-www-form-urlencoded)|.*\+(json|xml))/i
    .test(mimeType || "");
  if (isText) {
    try {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      return [text, false];
    } catch { /* fall through to base64 */ }
  }
  return [bytesToBase64(bytes), true];
}

function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// ─── Boot ───────────────────────────────────────────────────────────────────
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.hermesPort) reconnectNow();
});

connect();
