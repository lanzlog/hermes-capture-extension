const DEFAULT_PORT = 8898;

async function init() {
  const { hermesPort } = await browser.storage.local.get("hermesPort");
  document.getElementById("port").value = hermesPort || DEFAULT_PORT;
  refreshStatus();
  setInterval(refreshStatus, 1500);
}

async function refreshStatus() {
  // The badge text set by the background script reflects the connection.
  const text = await browser.browserAction.getBadgeText({});
  const connected = text === "on";
  document.getElementById("dot").className = "dot" + (connected ? " on" : "");
  document.getElementById("status").textContent =
    connected ? "Connected to Hermes" : "Disconnected";
}

document.getElementById("save").addEventListener("click", async () => {
  const port = parseInt(document.getElementById("port").value, 10) || DEFAULT_PORT;
  await browser.storage.local.set({ hermesPort: port });
  // Nudge the background script to reconnect with the new port.
  browser.runtime.reload();
  window.close();
});

init();
