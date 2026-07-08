# Wiring the bridge into the Hermes desktop app

The extension needs a WebSocket server on the app side. `bridge/hermes_bridge.py`
is that server. Steps to integrate into `hermes-har-recorder`:

## 1. Dependency

Add to `requirements.txt`:

```
websockets>=12.0
```

And to `build.py` PyInstaller args: `--hidden-import=websockets`.

## 2. Copy the bridge

Copy `bridge/hermes_bridge.py` into the app repo (next to `proxy_engine.py`).

## 3. Start the bridge in the GUI

In `HARRecorderWindow.__init__` (after the proxy engine is set up):

```python
from hermes_bridge import HermesBridge, entry_to_captured

self._bridge = HermesBridge(
    port=8898,
    on_status=lambda c, br: self.bridge_status.emit(c, br),
    on_windows=lambda br, w: self.bridge_windows.emit(br, w),
    on_entry=lambda e: self.flow_received.emit(entry_to_captured(e)),
    on_capture_started=lambda t: self.statusBar().showMessage(
        f"Capturing open window: {t.get('title','')}"),
    on_capture_stopped=lambda r: None,
    on_error=lambda m: self.proxy_error.emit(m),
)
self._bridge.start()
```

Define Qt signals `bridge_status = pyqtSignal(bool, str)` and
`bridge_windows = pyqtSignal(str, object)` so callbacks (which fire on the
bridge thread) marshal safely onto the GUI thread.

## 4. Populate the window picker

Keep the existing `browser_combo` entries ("Open new window", per-browser
launch). When `bridge_windows` fires, append separator + one item per open
window/tab, storing a payload in `Qt.UserRole`:

```python
def _on_bridge_windows(self, browser, windows):
    # remove previously added live-window items, then:
    for w in windows:
        for tab in w.tabs:
            label = f"🌐 {browser} • {tab.title[:40]}"
            self.browser_combo.addItem(label, {"live": True, "tabId": tab.id})
```

## 5. Route to the extension in `_route_traffic`

Extend the existing method:

```python
data = self.browser_combo.currentData()
if isinstance(data, dict) and data.get("live"):
    self._bridge.start_capture(tab_id=data["tabId"], follow_new=True)
    return
# ... existing system-proxy / launch-browser branches ...
```

## 6. Pause / Continue

In `_on_pause_toggle`, if the current capture is a live-window capture, also
call `self._bridge.pause()` / `self._bridge.resume()` alongside the proxy
engine pause. In `_on_stop`, call `self._bridge.stop_capture()`.

## 7. Cleanup

In `closeEvent`, call `self._bridge.stop()` before/after `proxy.shutdown()`.

## Data shape

Extension entries (see `bridge/hermes_bridge.py::entry_to_captured`) contain:
`method, url, status, statusText, requestHeaders, responseHeaders, requestBody,
responseBody, responseBase64, mimeType, remoteIP, type, startedDateTime`.
Map these onto your `CapturedRequest` dataclass — adjust field names in
`entry_to_captured` to match.
