// Hermes Capture — background service worker (MV3).
//
// Responsibilities:
//   1. Keep a WebSocket to the Hermes desktop app (localhost).
//   2. Report the browser's open windows/tabs so the app can list them.
//   3. On request, attach the debugger to a chosen tab and stream its
//      network traffic to the app via the Chrome DevTools Protocol (CDP).
//   4. Automatically follow popups / new tabs opened from a captured tab.
//   5. Support pause / resume / stop.
//
// Capturing an already-open tab is possible because chrome.debugger attaches
// to a live tab without restarting the browser — which the proxy approach
// cannot do.

import { DEFAULT_PORT, RECONNECT_MS, wsUrl } from "./protocol.js";

const PROTOCOL_VERSION = "1.3";

let ws = null;
let reconnectTimer = null;

// Set of tabIds we're currently capturing (a captured "window" = its tabs).
const capturedTabs = new Set();
let paused = false;
let followNew = true;

// Per-request scratch data keyed by `${tabId}:${requestId}`.
const pending = new Map();

// ─── Browser detection ──────────────────────────────────────────────────────
function detectBrowser() {
  const ua = navigator.userAgent;
  if (ua.includes("Edg/")) return "edge";
  if (ua.includes("Brave")) return "brave";
  if (ua.includes("OPR/")) return "opera";
  return "chrome";
}

// ─── WebSocket plumbing ─────────────────────────────────────────────────────
async function getPort() {
  const { hermesPort } = await chrome.storage.local.get("hermesPort");
  return hermesPort || DEFAULT_PORT;
}

async function connect() {
  clearTimeout(reconnectTimer);
  const port = await getPort();
  try {
    ws = new WebSocket(wsUrl(port));
  } catch (e) {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    send({ type: "hello", browser: detectBrowser(), version: PROTOCOL_VERSION });
    reportWindows();
    setBadge("on", "#98C379");
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleCommand(msg).catch((e) => send({ type: "error", message: String(e) }));
  };
  ws.onclose = () => { setBadge("", "#666"); scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, RECONNECT_MS);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

// ─── Window / tab listing ───────────────────────────────────────────────────
async function reportWindows() {
  const wins = await chrome.windows.getAll({ populate: true });
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
    const tabs = await chrome.tabs.query({ windowId });
    tabIds = tabs.map((t) => t.id);
  }
  for (const id of tabIds) await attach(id);
  const info = tabIds.length ? await safeTab(tabIds[0]) : null;
  send({
    type: "capture_started",
    target: info
      ? { tabId: info.id, windowId: info.windowId, title: info.title, url: info.url }
      : { tabId, windowId },
  });
  reportWindows();
}

async function attach(tabId) {
  if (capturedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", {
      maxTotalBufferSize: 50_000_000,
      maxResourceBufferSize: 20_000_000,
    });
    await chrome.debugger.sendCommand({ tabId }, "Page.enable", {});
    capturedTabs.add(tabId);
  } catch (e) {
    send({ type: "error", message: `attach ${tabId}: ${e.message || e}` });
  }
}

async function detach(tabId) {
  if (!capturedTabs.has(tabId)) return;
  capturedTabs.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch {}
}

async function stopAll(reason) {
  for (const id of Array.from(capturedTabs)) await detach(id);
  pending.clear();
  paused = false;
  send({ type: "capture_stopped", reason: reason || "user" });
  reportWindows();
}

// ─── CDP network events ─────────────────────────────────────────────────────
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null || !capturedTabs.has(tabId)) return;
  if (paused) return;
  const key = `${tabId}:${params.requestId}`;

  if (method === "Network.requestWillBeSent") {
    const r = params.request;
    pending.set(key, {
      tabId,
      requestId: params.requestId,
      startedDateTime: new Date(params.wallTime ? params.wallTime * 1000 : Date.now()).toISOString(),
      method: r.method,
      url: r.url,
      requestHeaders: r.headers || {},
      requestBody: r.postData || "",
      type: params.type || "",
    });
  } else if (method === "Network.responseReceived") {
    const e = pending.get(key);
    if (!e) return;
    const resp = params.response;
    e.status = resp.status;
    e.statusText = resp.statusText;
    e.responseHeaders = resp.headers || {};
    e.mimeType = resp.mimeType;
    e.remoteIP = resp.remoteIPAddress || "";
  } else if (method === "Network.loadingFinished") {
    finalize(tabId, params.requestId, key);
  } else if (method === "Network.loadingFailed") {
    const e = pending.get(key);
    if (e) {
      e.error = params.errorText || "failed";
      emitEntry(e);
      pending.delete(key);
    }
  }
});

async function finalize(tabId, requestId, key) {
  const e = pending.get(key);
  if (!e) return;
  try {
    const body = await chrome.debugger.sendCommand(
      { tabId }, "Network.getResponseBody", { requestId });
    e.responseBody = body.body || "";
    e.responseBase64 = !!body.base64Encoded;
  } catch {
    e.responseBody = "";
    e.responseBase64 = false;
  }
  emitEntry(e);
  pending.delete(key);
}

function emitEntry(e) {
  if (paused) return;
  send({ type: "entry", entry: e });
}

// ─── Follow popups / new tabs from a captured tab ───────────────────────────
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!followNew || capturedTabs.size === 0) return;
  // Attach if the new tab was opened by a tab we're already capturing, or if
  // it lives in a window we're capturing.
  const opener = tab.openerTabId;
  if (opener && capturedTabs.has(opener)) {
    await attach(tab.id);
    reportWindows();
    return;
  }
  // Same-window popups (target=_blank without opener set) — attach if any
  // captured tab shares this window.
  const capturedWindows = new Set();
  for (const id of capturedTabs) {
    const t = await safeTab(id);
    if (t) capturedWindows.add(t.windowId);
  }
  if (capturedWindows.has(tab.windowId)) {
    await attach(tab.id);
    reportWindows();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (capturedTabs.has(tabId)) {
    capturedTabs.delete(tabId);
    reportWindows();
  }
});

// If a captured tab's debugger detaches (e.g. devtools opened), clean up.
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId != null && capturedTabs.has(source.tabId)) {
    capturedTabs.delete(source.tabId);
    send({ type: "error", message: `debugger detached from ${source.tabId}: ${reason}` });
    reportWindows();
  }
});

// Keep the app's window list fresh as the user opens/closes things.
chrome.tabs.onUpdated.addListener((_, info) => {
  if (info.status === "complete" || info.title) throttleReport();
});
chrome.windows.onCreated.addListener(throttleReport);
chrome.windows.onRemoved.addListener(throttleReport);

let reportTimer = null;
function throttleReport() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(reportWindows, 400);
}

async function safeTab(tabId) {
  try { return await chrome.tabs.get(tabId); } catch { return null; }
}

// ─── Boot ───────────────────────────────────────────────────────────────────
connect();
