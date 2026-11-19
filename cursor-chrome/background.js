import { DEFAULT_TOKEN } from "./lib/default-token.js";
import { assertControllable, blockedBy } from "./lib/url-policy.js";

const BRIDGE = "http://127.0.0.1:39221";

let settings = { token: "", blockedPatterns: [] };
let pollGeneration = 0;
let pollRunning = false;
let starting = null;
let working = false;
let controlledTabId = null;
let idleTimer = null;
let aborted = false;
let currentStatus = "";
let currentDetail = "";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function init() {
  if (!starting) starting = doInit();
  return starting;
}

async function doInit() {
  try {
    chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: "#1f6b4a" });
    await loadSettings();
    chrome.alarms.create("keepalive", { periodInMinutes: 1 });
    if (settings.token) kick();
    else await setStatus("needs_token", "Disconnected. Click Connect.");
    chrome.storage.session.set({ approval: null }).catch(() => {});
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) await rememberTab(tab);
  } catch (error) {
    await setStatus("error", error.message);
  }
}

async function loadSettings() {
  const data = await chrome.storage.local.get(["token", "blockedPatterns", "manualDisconnect"]);
  let token = data.token || "";
  if (!token && !data.manualDisconnect) {
    token = DEFAULT_TOKEN;
    await chrome.storage.local.set({ token });
  }
  settings = {
    token,
    blockedPatterns: data.blockedPatterns || [],
  };
}

function headers() {
  return {
    "content-type": "application/json",
    "x-cursor-chrome-token": settings.token,
  };
}

function kick() {
  if (pollRunning || !settings.token) return;
  pollRunning = true;
  runPollLoop(++pollGeneration);
}

async function runPollLoop(generation) {
  await setStatus("connecting", "Waiting for the Cursor bridge on 127.0.0.1:39221");
  try {
    while (generation === pollGeneration) {
      if (!settings.token) {
        await setStatus("needs_token", "Paste the pairing token from cursor-chrome/bridge/.token");
        return;
      }
      let activeId = null;
      try {
        const response = await fetch(`${BRIDGE}/poll`, {
          method: "POST",
          headers: headers(),
          body: "{}",
        });
        if (generation !== pollGeneration) return;
        if (response.status === 401) {
          await setStatus("unauthorized", "The bridge rejected this token");
          await sleep(3000);
          continue;
        }
        if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
        const body = await response.json();
        await setStatus("connected", "");
        if (!body.command) continue;
        activeId = body.command.id;
        const outcome = await handleCommand(body.command);
        activeId = null;
        if (generation !== pollGeneration) {
          await postResult({ id: body.command.id, ok: false, error: "Extension restarted the connection" });
          return;
        }
        await postResult({ id: body.command.id, ...outcome });
      } catch (error) {
        if (activeId) {
          await postResult({ id: activeId, ok: false, error: error.message || "Extension error" });
        }
        if (generation !== pollGeneration) return;
        await setStatus("connecting", "Waiting for the Cursor bridge on 127.0.0.1:39221");
        pushLog(error.message || "Bridge connection failed");
        await sleep(1500);
      }
    }
  } finally {
    pollRunning = false;
  }
}

async function postResult(payload) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${BRIDGE}/result`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
      });
      if (response.ok) return;
    } catch {
      // The bridge may still be coming back. Retry below.
    }
    await sleep(250);
  }
  pushLog("Could not deliver a result to the bridge");
}

async function handleCommand(command) {
  aborted = false;
  const params = command.params || {};
  pushLog(summarize(command.method, params));
  try {
    const result = await dispatch(command.method, params);
    if (aborted) return { ok: false, error: "Stopped by user" };
    return { ok: true, result };
  } catch (error) {
    const message = explain(error);
    pushLog(message);
    return { ok: false, error: message };
  }
}

function summarize(method, params) {
  if (method === "browser_type") return `${method} ${params.ref || ""}`.trim();
  if (method === "browser_evaluate") return `${method} ${String(params.script || "").slice(0, 60)}`.trim();
  if (method === "browser_navigate" || method === "browser_new_tab") return `${method} ${params.url || ""}`.trim();
  if (params.ref) return `${method} ${params.ref}`;
  return method;
}

function explain(error) {
  const text = String(error?.message || error);
  if (text.includes("Cannot access") || text.includes("cannot be scripted") || text.includes("showing error page")) {
    return "This page can't be controlled. Restricted pages include the Chrome Web Store, browser settings, and PDFs.";
  }
  if (text.includes("Extension context invalidated")) return "Refresh this tab, then try again.";
  return text;
}

async function dispatch(method, params) {
  switch (method) {
    case "browser_tabs":
      return listTabs();
    case "browser_navigate":
      return navigate(params);
    case "browser_new_tab":
      return newTab(params);
    case "browser_snapshot":
      return runOnTab(tabIdOf(params), (tab) => pageAction(tab, "snapshot", params));
    case "browser_click":
      return runOnTab(tabIdOf(params), (tab) => pageAction(tab, "click", params));
    case "browser_type":
      return runOnTab(tabIdOf(params), (tab) => pageAction(tab, "type", params));
    case "browser_press_key":
      return runOnTab(tabIdOf(params), (tab) => pageAction(tab, "press_key", params));
    case "browser_scroll":
      return runOnTab(tabIdOf(params), (tab) => pageAction(tab, "scroll", params));
    case "browser_hover":
      return runOnTab(tabIdOf(params), (tab) => pageAction(tab, "hover", params));
    case "browser_select":
      return runOnTab(tabIdOf(params), (tab) => pageAction(tab, "select", params));
    case "browser_screenshot":
      return screenshot(params);
    case "browser_back":
      return history(params, -1);
    case "browser_forward":
      return history(params, 1);
    case "browser_wait":
      return wait(params);
    case "browser_close_tab":
      return closeTab(params);
    case "browser_focus_tab":
      return focusTab(params);
    case "browser_evaluate":
      return evaluate(params);
    default:
      throw new Error(`Unknown method ${method}`);
  }
}

function tabIdOf(params) {
  if (params?.tabId == null || params.tabId === "") return undefined;
  const id = Number(params.tabId);
  if (!Number.isInteger(id)) throw new Error("tabId must be an integer");
  return id;
}

async function resolveTab(tabId) {
  try {
    if (tabId == null) {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) throw new Error("No active tab");
      return tab;
    }
    return await chrome.tabs.get(tabId);
  } catch (error) {
    if (tabId != null) throw new Error(`No tab with id ${tabId}`);
    throw error;
  }
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs.slice(0, 100).map((tab) => ({
      tabId: tab.id,
      windowId: tab.windowId,
      active: Boolean(tab.active),
      title: tab.title || "",
      url: tab.url || "",
      controllable: Boolean(tab.url && controllable(tab.url) && !blockedBy(tab.url, settings.blockedPatterns)),
    })),
  };
}

function controllable(url) {
  try {
    assertControllable(url);
    return true;
  } catch {
    return false;
  }
}

async function withAccess(url, fn) {
  const parsed = assertControllable(url);
  const pattern = blockedBy(parsed.href, settings.blockedPatterns);
  if (pattern) throw new Error(`Blocked by pattern "${pattern}"`);
  if (aborted) throw new Error("Stopped by user");
  return fn();
}

async function runOnTab(tabId, fn) {
  const tab = await resolveTab(tabId);
  if (!tab.url) throw new Error("This tab has no URL yet");
  return withAccess(tab.url, async () => {
    await setWorking(tab.id, true);
    try {
      if (aborted) throw new Error("Stopped by user");
      return await fn(await chrome.tabs.get(tab.id));
    } finally {
      scheduleIdle(tab.id);
    }
  });
}

async function pageAction(tab, type, params) {
  const response = await sendToPage(tab.id, { type, ...params, tabId: undefined });
  if (!response?.ok) throw new Error(response?.error || "The page did not respond");
  return { tabId: tab.id, url: tab.url, ...response.result };
}

async function sendToPage(tabId, message) {
  const payload = { target: "cursor-page", ...message };
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    if (String(error?.message || error).includes("Extension context invalidated")) {
      throw new Error("Refresh this tab, then try again.");
    }
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content/page.js"] });
  return chrome.tabs.sendMessage(tabId, payload);
}

async function navigate(params) {
  if (!params.url) throw new Error("url is required");
  const tab = await resolveTab(tabIdOf(params));
  return withAccess(params.url, async () => {
    await setWorking(tab.id, true);
    try {
      const pending = watchForLoad(tab.id);
      await chrome.tabs.update(tab.id, { url: params.url });
      pending.accept(params.url);
      const finished = await pending.done;
      await sleep(300);
      const updated = await chrome.tabs.get(tab.id);
      setWorking(updated.id, true);
      await rememberTab(updated);
      return { tabId: updated.id, url: updated.url, title: updated.title || "", loaded: finished };
    } finally {
      scheduleIdle(tab.id);
    }
  });
}

async function newTab(params) {
  if (!params.url) throw new Error("url is required");
  return withAccess(params.url, async () => {
    const tab = await chrome.tabs.create({ url: params.url, active: true });
    await groupTab(tab.id);
    await setWorking(tab.id, true);
    try {
      const pending = watchForLoad(tab.id);
      pending.accept(params.url, true);
      const finished = await pending.done;
      await sleep(300);
      const updated = await chrome.tabs.get(tab.id);
      setWorking(updated.id, true);
      await rememberTab(updated);
      return { tabId: updated.id, url: updated.url, title: updated.title || "", loaded: finished };
    } finally {
      scheduleIdle(tab.id);
    }
  });
}

const GROUP_TITLE = "Cursor";

async function groupTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const groups = await chrome.tabGroups.query({ title: GROUP_TITLE });
    const inWindow = groups.filter((group) => group.windowId === tab.windowId);
    if (inWindow.length) {
      const target = inWindow[0];
      await chrome.tabs.group({ tabIds: [tabId], groupId: target.id });
      await foldCursorGroups(inWindow.slice(1), target);
      await chrome.tabGroups.update(target.id, { title: GROUP_TITLE, color: "blue", collapsed: false });
      return;
    }
    if (groups.length) {
      const target = await preferredCursorGroup(groups);
      if (tab.windowId !== target.windowId) {
        await chrome.tabs.move(tabId, { windowId: target.windowId, index: -1 });
      }
      await chrome.tabs.group({ tabIds: [tabId], groupId: target.id });
      await chrome.tabGroups.update(target.id, { title: GROUP_TITLE, color: "blue", collapsed: false });
      return;
    }
    const groupId = await chrome.tabs.group({
      tabIds: [tabId],
      createProperties: { windowId: tab.windowId },
    });
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "blue" });
  } catch {
    // Grouping can fail for pinned tabs or unsupported windows.
  }
}

async function preferredCursorGroup(groups) {
  const focused = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  const inFocus = groups.find((group) => group.windowId === focused?.id);
  if (inFocus) return inFocus;
  let best = groups[0];
  let bestCount = -1;
  for (const group of groups) {
    const tabs = await chrome.tabs.query({ groupId: group.id });
    if (tabs.length > bestCount) {
      best = group;
      bestCount = tabs.length;
    }
  }
  return best;
}

async function foldCursorGroups(extras, target) {
  for (const group of extras) {
    const members = await chrome.tabs.query({ groupId: group.id });
    const ids = members.map((member) => member.id).filter((id) => id != null);
    if (!ids.length) continue;
    await chrome.tabs.group({ tabIds: ids, groupId: target.id });
  }
}

function watchForLoad(tabId, timeoutMs = 20000) {
  let settled = false;
  let sawLoading = false;
  let resolveDone = () => {};
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    resolveDone(value);
  };
  const timer = setTimeout(() => finish(false), timeoutMs);
  function onUpdated(id, info) {
    if (id !== tabId) return;
    if (info.status === "loading") sawLoading = true;
    if (info.status === "complete") finish(true);
  }
  chrome.tabs.onUpdated.addListener(onUpdated);
  return {
    done,
    accept(url, loose = false) {
      chrome.tabs.get(tabId).then((tab) => {
        if (tab.status !== "complete" || !tab.url) return;
        if (loose || tab.url === url) finish(true);
      }).catch(() => {});
    },
    settleIfQuiet(ms) {
      return sleep(ms).then(() => {
        if (settled || sawLoading) return done;
        finish(false);
        return false;
      });
    },
  };
}

async function screenshot(params) {
  return runOnTab(tabIdOf(params), async (tab) => {
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.querySelector("[data-cursor-chrome-ui]")?.remove(),
    }).catch(() => {});
    await sleep(80);
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 55 });
      const comma = dataUrl.indexOf(",");
      return {
        tabId: tab.id,
        url: tab.url,
        title: tab.title || "",
        mimeType: "image/jpeg",
        data: dataUrl.slice(comma + 1),
      };
    } finally {
      setWorking(tab.id, true);
    }
  });
}

async function history(params, direction) {
  return runOnTab(tabIdOf(params), async (tab) => {
    const pending = watchForLoad(tab.id);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (step) => (step < 0 ? history.back() : history.forward()),
      args: [direction],
    });
    const finished = await Promise.race([pending.done, pending.settleIfQuiet(800)]);
    await sleep(300);
    const updated = await chrome.tabs.get(tab.id);
    const pattern = updated.url ? blockedBy(updated.url, settings.blockedPatterns) : null;
    if (pattern) throw new Error(`Blocked by pattern "${pattern}"`);
    await rememberTab(updated);
    return { tabId: updated.id, url: updated.url, title: updated.title || "", loaded: finished };
  });
}

async function wait(params) {
  if (params.ms == null) throw new Error("ms is required");
  const delay = Math.max(0, Math.min(Number(params.ms) || 0, 10000));
  await sleep(delay);
  return { waited: delay };
}

async function closeTab(params) {
  const tab = await resolveTab(tabIdOf(params));
  if (!tab.url || !controllable(tab.url)) {
    await chrome.tabs.remove(tab.id);
    return { closed: tab.id };
  }
  return withAccess(tab.url, async () => {
    await chrome.tabs.remove(tab.id);
    return { closed: tab.id };
  });
}

async function focusTab(params) {
  const tab = await resolveTab(tabIdOf(params));
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  const updated = await chrome.tabs.get(tab.id);
  await rememberTab(updated);
  return { tabId: updated.id, url: updated.url, title: updated.title || "" };
}

async function evaluate(params) {
  const script = params.script == null ? "" : String(params.script);
  if (!script) throw new Error("script is required");
  if (script.length > 20000) throw new Error("script is too long");
  return runOnTab(tabIdOf(params), async (tab) => {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (source) => {
        try {
          const value = await (0, eval)(source);
          if (value === undefined) return { ok: true, value: "undefined" };
          const seen = new WeakSet();
          const text = JSON.stringify(value, (_key, item) => {
            if (typeof item === "bigint") return item.toString();
            if (typeof item === "function") return undefined;
            if (item && typeof item === "object") {
              if (seen.has(item)) return "[Circular]";
              seen.add(item);
            }
            return item;
          });
          const packed = text == null ? String(value) : text;
          return { ok: true, value: packed.length > 20000 ? `${packed.slice(0, 20000)}…[truncated]` : packed };
        } catch (error) {
          return { ok: false, error: String(error?.message || error) };
        }
      },
      args: [script],
    });
    if (!injection?.result?.ok) throw new Error(injection?.result?.error || "Script failed");
    return { tabId: tab.id, url: tab.url, value: injection.result.value };
  });
}

function setWorking(tabId, on) {
  if (on) clearTimeout(idleTimer);
  working = on;
  controlledTabId = tabId;
  refreshBadge();
  chrome.storage.session.set({ working: on }).catch(() => {});
  if (tabId != null) sendToPage(tabId, { type: "working", on }).catch(() => {});
}

function scheduleIdle(tabId) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    setWorking(tabId, false);
  }, 800);
}

function refreshBadge() {
  chrome.action.setBadgeText({ text: working ? "ON" : "" });
}

function stopAgent() {
  const hadWork = working;
  aborted = true;
  clearTimeout(idleTimer);
  working = false;
  const tabId = controlledTabId;
  refreshBadge();
  chrome.storage.session.set({ working: false, approval: null }).catch(() => {});
  if (tabId != null) sendToPage(tabId, { type: "working", on: false }).catch(() => {});
  if (!hadWork) pushLog("Stopped");
}

function pushLog(line) {
  chrome.storage.session.get("log").then((data) => {
    const log = Array.isArray(data.log) ? data.log : [];
    log.unshift({ t: Date.now(), line: String(line).slice(0, 300) });
    return chrome.storage.session.set({ log: log.slice(0, 80) });
  }).catch(() => {});
}

async function setStatus(status, detail = "") {
  if (currentStatus === status && currentDetail === detail) return;
  currentStatus = status;
  currentDetail = detail;
  await chrome.storage.session.set({ status, statusDetail: detail });
}

async function rememberTab(tab) {
  if (!tab?.active) return;
  await chrome.storage.session.set({
    currentTab: { id: tab.id, title: tab.title || "", url: tab.url || "" },
  });
}

async function saveToken(token) {
  const clean = String(token || "").trim().toLowerCase() || DEFAULT_TOKEN;
  if (!/^[a-f0-9]{64}$/.test(clean)) {
    return { ok: false, error: "Token should be 64 hex characters from bridge/.token" };
  }
  settings.token = clean;
  await chrome.storage.local.set({ token: clean, manualDisconnect: false });
  kick();
  return { ok: true };
}

async function disconnect() {
  settings.token = "";
  await chrome.storage.local.set({ token: "", manualDisconnect: true });
  pollGeneration += 1;
  await setStatus("needs_token", "Disconnected. Click Connect.");
  return { ok: true };
}

async function getState() {
  const session = await chrome.storage.session.get([
    "status", "statusDetail", "log", "currentTab", "working",
  ]);
  return {
    ok: true,
    hasToken: Boolean(settings.token),
    status: session.status || currentStatus || "needs_token",
    statusDetail: session.statusDetail || "",
    log: session.log || [],
    currentTab: session.currentTab || null,
    working: Boolean(session.working),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object" || message.target === "cursor-page") return;
  if (message.type === "STOP") {
    stopAgent();
    sendResponse({ ok: true });
    return;
  }
  const tasks = {
    SAVE_TOKEN: () => saveToken(message.token),
    DISCONNECT: () => disconnect(),
    GET_STATE: () => getState(),
  };
  const task = tasks[message.type];
  if (!task) return;
  task().then(sendResponse);
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-side-panel") return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.windowId == null) return;
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive" && settings.token) kick();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.token) settings.token = changes.token.newValue || "";
  if (changes.blockedPatterns) settings.blockedPatterns = changes.blockedPatterns.newValue || [];
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    await rememberTab(await chrome.tabs.get(tabId));
  } catch {
    // The tab can close before we read it.
  }
});

chrome.tabs.onUpdated.addListener((_tabId, _info, tab) => {
  if (tab.active) rememberTab(tab);
});

chrome.runtime.onInstalled.addListener(() => init());
chrome.runtime.onStartup.addListener(() => init());
init();
