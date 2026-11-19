const statusEl = document.querySelector("#status");
const dotEl = document.querySelector("#status-dot");
const detailEl = document.querySelector("#detail");
const setupEl = document.querySelector("#setup");
const pairedEl = document.querySelector("#paired");
const pairedText = document.querySelector("#paired-text");
const tabTitle = document.querySelector("#tab-title");
const tabUrl = document.querySelector("#tab-url");
const logEl = document.querySelector("#log");
const stopBtn = document.querySelector("#stop");
const tokenInput = document.querySelector("#token");
const tokenError = document.querySelector("#token-error");
const connectBtn = document.querySelector("#connect");
const pasteBtn = document.querySelector("#paste");
let replacingToken = false;

const STATUS_LABELS = {
  connected: "Connected",
  connecting: "Connecting",
  needs_token: "Not connected",
  unauthorized: "Token rejected",
  error: "Connection problem",
};

function clock(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour12: false });
}

function render(state) {
  if (!state) return;
  const status = state.status || "needs_token";
  statusEl.textContent = STATUS_LABELS[status] || "Not connected";
  dotEl.dataset.state = status;
  detailEl.textContent = state.statusDetail || "";
  const needsToken = !state.hasToken || status === "unauthorized" || status === "needs_token" || replacingToken;
  setupEl.hidden = !needsToken;
  pairedEl.hidden = needsToken;
  pairedText.textContent = status === "connected"
    ? "Paired with the local bridge. Sites are controlled without an extra prompt."
    : "Trying to reach the bridge at 127.0.0.1:39221.";

  tabTitle.textContent = state.currentTab?.title || "No active tab";
  tabUrl.textContent = state.currentTab?.url || "";
  stopBtn.disabled = !state.working;

  logEl.replaceChildren();
  const entries = state.log?.length ? state.log : [{ t: Date.now(), line: "No activity yet." }];
  for (const entry of entries) {
    const item = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = entry.t ? clock(entry.t) : "";
    time.dateTime = entry.t ? new Date(entry.t).toISOString() : "";
    const text = document.createElement("span");
    text.textContent = entry.line;
    item.append(time, text);
    logEl.append(item);
  }
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  render(state);
}

pasteBtn.addEventListener("click", async () => {
  tokenError.textContent = "";
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) throw new Error("empty");
    tokenInput.value = text;
    tokenInput.focus();
  } catch {
    tokenError.textContent = "Clipboard was blocked. Click the field and paste with Command-V or Ctrl-V.";
    tokenInput.focus();
  }
});

connectBtn.addEventListener("click", async () => {
  tokenError.textContent = "";
  const token = tokenInput.value.trim();
  if (!token) {
    tokenError.textContent = "Paste the token from cursor-chrome/bridge/.token.";
    tokenInput.focus();
    return;
  }
  connectBtn.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: "SAVE_TOKEN", token });
  connectBtn.disabled = false;
  if (!response?.ok) tokenError.textContent = response?.error || "Could not save the token";
  else {
    tokenInput.value = "";
    replacingToken = false;
  }
});

tokenInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") connectBtn.click();
});

document.querySelector("#disconnect").addEventListener("click", () => {
  replacingToken = false;
  chrome.runtime.sendMessage({ type: "DISCONNECT" });
});

document.querySelector("#replace-token").addEventListener("click", () => {
  replacingToken = true;
  tokenError.textContent = "";
  refresh();
  tokenInput.focus();
});

stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP" });
});

document.querySelector("#options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

for (const link of document.querySelectorAll("a.token-link")) {
  link.addEventListener("click", (event) => {
    if (!globalThis.chrome?.tabs?.create) return;
    event.preventDefault();
    chrome.tabs.create({ url: link.href }).catch(() => {
      window.open(link.href, "_blank", "noopener");
    });
  });
}

chrome.commands.getAll().then((commands) => {
  const command = commands.find((entry) => entry.name === "toggle-side-panel");
  document.querySelector("#shortcut").textContent = command?.shortcut || "";
}).catch(() => {});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "session" || area === "local") refresh();
});

refresh();
