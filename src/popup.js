const DEFAULT_PORT = 8898;

async function init() {
  const { hermesPort, hermesEnabled } = await chrome.storage.local.get([
    "hermesPort",
    "hermesEnabled",
  ]);
  document.getElementById("port").value = hermesPort || DEFAULT_PORT;
  const enabled = hermesEnabled !== false; // default ON
  document.getElementById("enabled").checked = enabled;
  updateEnabledLabel(enabled);
  refreshStatus();
  setInterval(refreshStatus, 1500);
}

function updateEnabledLabel(enabled) {
  const el = document.getElementById("enabledLabel");
  el.textContent = enabled ? "ON" : "OFF";
  el.className = "switch-label" + (enabled ? "" : " off");
}

async function refreshStatus() {
  const { hermesEnabled } = await chrome.storage.local.get("hermesEnabled");
  const enabled = hermesEnabled !== false;
  const text = await chrome.action.getBadgeText({});
  const connected = text === "on";
  const waiting = text === "…" || text === "...";
  const off = text === "off" || !enabled;

  const dot = document.getElementById("dot");
  if (off) {
    dot.className = "dot off";
    document.getElementById("status").textContent = "Disabled";
  } else if (connected) {
    dot.className = "dot on";
    document.getElementById("status").textContent = "Connected to Hermes";
  } else if (waiting) {
    dot.className = "dot wait";
    document.getElementById("status").textContent = "Waiting for app…";
  } else {
    dot.className = "dot";
    document.getElementById("status").textContent = "Disconnected";
  }
}

document.getElementById("enabled").addEventListener("change", async (ev) => {
  const enabled = ev.target.checked;
  updateEnabledLabel(enabled);
  await chrome.storage.local.set({ hermesEnabled: enabled });
  // background listens to storage.onChanged → enable/disable immediately
  refreshStatus();
});

document.getElementById("save").addEventListener("click", async () => {
  const port = parseInt(document.getElementById("port").value, 10) || DEFAULT_PORT;
  const enabled = document.getElementById("enabled").checked;
  await chrome.storage.local.set({ hermesPort: port, hermesEnabled: enabled });
  // Full SW reload is the most reliable port/enable apply.
  chrome.runtime.reload();
  window.close();
});

init();
