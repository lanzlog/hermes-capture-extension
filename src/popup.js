const DEFAULT_PORT = 8898;

async function init() {
  const { hermesPort } = await chrome.storage.local.get("hermesPort");
  document.getElementById("port").value = hermesPort || DEFAULT_PORT;
  refreshStatus();
  setInterval(refreshStatus, 1500);
}

async function refreshStatus() {
  // Badge text set by the service worker: "on" | "…" | "".
  const text = await chrome.action.getBadgeText({});
  const connected = text === "on";
  const waiting = text === "…";
  const dot = document.getElementById("dot");
  dot.className = "dot" + (connected ? " on" : waiting ? " wait" : "");
  document.getElementById("status").textContent = connected
    ? "Connected to Hermes"
    : waiting
      ? "Waiting for app…"
      : "Disconnected";
}

document.getElementById("save").addEventListener("click", async () => {
  const port = parseInt(document.getElementById("port").value, 10) || DEFAULT_PORT;
  await chrome.storage.local.set({ hermesPort: port });
  // Nudge the service worker to reconnect with the new port.
  chrome.runtime.reload();
  window.close();
});

init();
