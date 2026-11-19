// Local MCP bridge for Cursor in Chrome.
// Cursor launches this over stdio. The extension long-polls http://127.0.0.1:39221.
import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 39221;
const HOST = "127.0.0.1";
const tokenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), ".token");

const tabId = { type: "number", description: "Tab id from browser_tabs. Defaults to the active tab." };
const ref = { type: "string", description: "Element ref from browser_snapshot, such as e12." };

function tool(name, description, properties, required = []) {
  const inputSchema = { type: "object", properties };
  if (required.length) inputSchema.required = required;
  return { name, description, inputSchema };
}

const TOOLS = [
  tool("browser_tabs", "List open Chrome tabs. Controllable is false for restricted pages."),
  tool(
    "browser_navigate",
    "Open a URL in a tab. Uses the active tab unless tabId is set. Follow with browser_snapshot if you need to interact with the page.",
    { url: { type: "string", description: "Absolute http(s) or file URL." }, tabId },
    ["url"],
  ),
  tool(
    "browser_new_tab",
    "Open a URL in a new tab. The tab joins the existing Cursor tab group when one is already open, and a group is created only when none exists. Follow with browser_snapshot to read the page.",
    { url: { type: "string", description: "Absolute http(s) or file URL." } },
    ["url"],
  ),
  tool(
    "browser_snapshot",
    "Read the page as a text accessibility tree. Elements you can act on have refs like [e12]. Refs stay valid until that element leaves the page. Take a fresh snapshot after navigation or a click that changes the page.",
    {
      tabId,
      filter: { type: "string", enum: ["interactive", "all"], description: "interactive includes controls, headings, and landmarks. all also includes text. Default interactive." },
      query: { type: "string", description: "Only return tree lines containing this text. Refs still come from the full page." },
      depth: { type: "number", description: "Maximum included-node depth. Default 20." },
      maxChars: { type: "number", description: "Maximum characters of the tree. Default 50000." },
      rootSelector: { type: "string", description: "Optional CSS selector to start the tree from." },
    },
  ),
  tool("browser_click", "Click an element by ref. If the page changes, take a new snapshot.", { tabId, ref }, ["ref"]),
  tool(
    "browser_type",
    "Type into an element by ref. Replaces the current text unless clear is false. Password fields are typed but the value is not returned.",
    {
      tabId,
      ref,
      text: { type: "string" },
      clear: { type: "boolean", description: "Replace existing text. Default true." },
    },
    ["ref", "text"],
  ),
  tool(
    "browser_press_key",
    "Press a key or combo such as Enter, Tab, Escape, Backspace, Control+A, or Meta+L. Pass ref to focus an element first.",
    { tabId, ref, key: { type: "string" } },
    ["key"],
  ),
  tool(
    "browser_scroll",
    "Scroll the page, or the element for ref. deltaY defaults to 480 when both deltas are omitted.",
    { tabId, ref, deltaX: { type: "number" }, deltaY: { type: "number" } },
  ),
  tool("browser_hover", "Move the pointer over an element by ref.", { tabId, ref }, ["ref"]),
  tool(
    "browser_select",
    "Choose a select option by its visible text or value.",
    { tabId, ref, value: { type: "string" } },
    ["ref", "value"],
  ),
  tool(
    "browser_screenshot",
    "Capture a JPEG of the tab. This brings that Chrome window to the front. The on-page Cursor indicator is hidden for the capture.",
    { tabId },
  ),
  tool("browser_back", "Go back in the tab history.", { tabId }),
  tool("browser_forward", "Go forward in the tab history.", { tabId }),
  tool("browser_wait", "Wait for the page to settle, up to 10 seconds.", { ms: { type: "number" } }, ["ms"]),
  tool("browser_close_tab", "Close a tab. Defaults to the active tab.", { tabId }),
  tool("browser_focus_tab", "Bring a tab to the front.", { tabId }, ["tabId"]),
  tool(
    "browser_evaluate",
    "Run a JavaScript expression in the page. document is available. The page's own JavaScript variables are not. The site must already be allowed, or Chrome will ask.",
    { tabId, script: { type: "string" } },
    ["script"],
  ),
];

let token = "";
let mode = "primary";
let readyResolve = () => {};
const readyPromise = new Promise((resolve) => {
  readyResolve = resolve;
});

let lastSeen = 0;
let activePolls = 0;
let queue = [];
const pending = new Map();
let waiters = [];

function extensionAlive() {
  return activePolls > 0 || pending.size > 0 || (lastSeen > 0 && Date.now() - lastSeen < 22000);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExtension() {
  const start = Date.now();
  while (!extensionAlive()) {
    if (Date.now() - start > 6000) {
      throw new Error(
        "Chrome extension is not connected. Load the cursor-chrome folder as an unpacked extension, open the Cursor side panel, and paste the token from cursor-chrome/bridge/.token.",
      );
    }
    await delay(200);
  }
}

function enqueue(item) {
  item.timer = setTimeout(() => {
    queue = queue.filter((entry) => entry !== item);
    pending.delete(item.cmd.id);
    item.reject(new Error("Timed out waiting for the Chrome extension. Open the Cursor side panel and check the connection."));
  }, 180000);
  pending.set(item.cmd.id, item);
  const waiter = waiters.shift();
  if (waiter) waiter(item.cmd);
  else queue.push(item);
}

function callLocal(method, params) {
  const cmd = { id: randomUUID(), method, params: params || {} };
  return new Promise((resolve, reject) => {
    enqueue({ cmd, resolve, reject, timer: null });
  });
}

async function dispatchToExtension(method, params) {
  await waitForExtension();
  return callLocal(method, params || {});
}

function settle(id, payload) {
  const item = pending.get(id);
  if (!item) return false;
  clearTimeout(item.timer);
  pending.delete(id);
  queue = queue.filter((entry) => entry !== item);
  item.resolve(payload);
  return true;
}

function authorized(req) {
  const header = req.headers["x-cursor-chrome-token"];
  const presented = Array.isArray(header) ? header[0] : header;
  const got = Buffer.from(String(presented || ""));
  const want = Buffer.from(token);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req, limit = 12_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function jsonBody(req) {
  const text = await readBody(req);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

function handlePoll(req, res) {
  lastSeen = Date.now();
  activePolls += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activePolls = Math.max(0, activePolls - 1);
    lastSeen = Date.now();
  };
  req.on("close", release);
  res.on("close", release);

  let settled = false;
  const finish = (command) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    waiters = waiters.filter((entry) => entry !== finish);
    if (req.destroyed || res.writableEnded) return;
    try {
      sendJson(res, 200, { command });
    } catch {
      // The extension closed the poll.
    }
  };
  const timer = setTimeout(() => finish(null), 20000);
  if (queue.length) finish(queue.shift().cmd);
  else {
    waiters.push(finish);
    req.on("close", () => finish(null));
  }
}

async function handleHttp(req, res) {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, connected: extensionAlive() });
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  if (req.method === "POST" && url.pathname === "/poll") {
    handlePoll(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/result") {
    const body = await jsonBody(req);
    if (!body.id || !settle(body.id, { ok: Boolean(body.ok), result: body.result, error: body.error })) {
      sendJson(res, 404, { error: "unknown command" });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/call") {
    const body = await jsonBody(req);
    if (!body.method || typeof body.method !== "string") {
      sendJson(res, 400, { error: "method is required" });
      return;
    }
    const payload = await dispatchToExtension(body.method, body.params || {});
    sendJson(res, 200, payload);
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  handleHttp(req, res).catch((error) => {
    if (!res.headersSent) sendJson(res, error.status || 500, { error: error.message });
  });
});
server.requestTimeout = 0;

function listen() {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(PORT, HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function loadToken() {
  try {
    const existing = (await readFile(tokenPath, "utf8")).trim();
    if (/^[a-f0-9]{64}$/i.test(existing)) {
      await chmod(tokenPath, 0o600).catch(() => {});
      return existing.toLowerCase();
    }
  } catch {
    // Create a token below when the file is missing or unreadable.
  }
  const created = randomBytes(32).toString("hex");
  await writeFile(tokenPath, `${created}\n`, { encoding: "utf8", mode: 0o600 });
  return created;
}

async function proxyCall(method, params) {
  const response = await fetch(`http://${HOST}:${PORT}/call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cursor-chrome-token": token,
    },
    body: JSON.stringify({ method, params }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Bridge returned ${response.status}`);
  return payload;
}

function send(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
}

function rpcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toolResult(method, result) {
  if (method === "browser_screenshot" && result?.data) {
    const caption = `Screenshot of tab ${result.tabId} ${result.title || ""} ${result.url || ""}`.trim();
    return {
      content: [
        { type: "text", text: caption },
        { type: "image", data: result.data, mimeType: result.mimeType || "image/jpeg" },
      ],
    };
  }
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2) ?? "null";
  return { content: [{ type: "text", text }] };
}

async function callTool(params) {
  const name = params.name;
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  if (!TOOLS.some((entry) => entry.name === name)) return errorResult(`Unknown tool ${name}`);
  await readyPromise;
  try {
    const payload = mode === "proxy" ? await proxyCall(name, args) : await dispatchToExtension(name, args);
    if (!payload.ok) return errorResult(payload.error || "The extension returned an error");
    return toolResult(name, payload.result);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

async function handleRpc(method, params) {
  if (method === "initialize") {
    const requested = params.protocolVersion;
    return {
      protocolVersion: typeof requested === "string" && requested.startsWith("202") ? requested : "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "cursor-chrome", version: "1.0.0" },
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "tools/call") return callTool(params);
  if (method === "resources/list" || method === "resources/templates/list") return { resources: [] };
  if (method === "prompts/list") return { prompts: [] };
  throw rpcError(-32601, `Unknown method ${method}`);
}

function onMessage(message) {
  if (!message || message.jsonrpc !== "2.0" || message.id === undefined) return;
  handleRpc(message.method, message.params || {})
    .then((result) => send({ jsonrpc: "2.0", id: message.id, result }))
    .catch((error) => {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: error.code || -32603, message: error.message },
      });
    });
}

let buffer = Buffer.alloc(0);
function parseBuffer() {
  while (buffer.length) {
    if (buffer[0] === 0x7b) {
      const end = buffer.indexOf(0x0a);
      if (end === -1) return;
      const line = buffer.slice(0, end).toString("utf8").trim();
      buffer = buffer.slice(end + 1);
      if (line) onMessage(JSON.parse(line));
      continue;
    }
    const separator = buffer.indexOf("\r\n\r\n");
    if (separator === -1) return;
    const header = buffer.slice(0, separator).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.slice(separator + 4);
      continue;
    }
    const length = Number(match[1]);
    const start = separator + 4;
    if (buffer.length < start + length) return;
    const body = buffer.slice(start, start + length).toString("utf8");
    buffer = buffer.slice(start + length);
    onMessage(JSON.parse(body));
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  try {
    parseBuffer();
  } catch (error) {
    console.error("cursor-chrome bridge parse error:", error.message);
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();

async function main() {
  token = await loadToken();
  try {
    await listen();
    mode = "primary";
    console.error(`cursor-chrome bridge listening on ${HOST}:${PORT}`);
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    mode = "proxy";
    console.error(`cursor-chrome bridge already running; forwarding to ${HOST}:${PORT}`);
  }
  console.error(`cursor-chrome pairing token file: ${tokenPath}`);
  readyResolve();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
