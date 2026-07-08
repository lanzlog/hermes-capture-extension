// Shared protocol constants + helpers for the Hermes Capture extension.
//
// The extension talks to the Hermes desktop app over a WebSocket that the
// app hosts on localhost. All messages are JSON objects with a `type` field.
//
// Extension -> Hermes:
//   {type:"hello", browser, version}
//   {type:"windows", windows:[{id, focused, incognito, tabs:[{id,title,url,active,windowId}]}]}
//   {type:"capture_started", target:{tabId, windowId, title, url}}
//   {type:"entry", entry:{...HAR-like request/response...}}
//   {type:"capture_stopped", reason}
//   {type:"paused"} / {type:"resumed"}
//   {type:"error", message}
//
// Hermes -> Extension:
//   {type:"list_windows"}
//   {type:"start_capture", tabId, followNew:true}
//   {type:"pause"} / {type:"resume"}
//   {type:"stop_capture"}
//
// Default port must match extension_bridge.py in the Hermes app.
export const DEFAULT_PORT = 8898;
export const RECONNECT_MS = 2000;

export function wsUrl(port) {
  return `ws://127.0.0.1:${port}/hermes`;
}
