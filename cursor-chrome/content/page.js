(() => {
  if (globalThis.__cursorChrome) return;
  globalThis.__cursorChrome = true;

  const SKIP = new Set(["script", "style", "noscript", "template", "path", "defs", "clippath"]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "switch", "tab",
    "menuitem", "menuitemcheckbox", "menuitemradio", "option",
    "textbox", "searchbox", "combobox", "slider", "spinbutton",
  ]);

  const refToEl = new Map();
  const elToRef = new WeakMap();
  let refCounter = 0;
  let ui = null;

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
  }

  function isHidden(el) {
    const style = getComputedStyle(el);
    return style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
  }

  function isSensitive(el) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
      return false;
    }
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password" || type === "hidden") return true;
    const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
    return /password|cc-number|cc-csc|one-time-code/.test(autocomplete);
  }

  function isEditable(el) {
    const value = el.getAttribute("contenteditable");
    return value === "" || value === "true" || value === "plaintext-only";
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    if (tag === "a") return el.hasAttribute("href") || role === "button" || role === "link";
    if (tag === "button" || tag === "input" || tag === "select" || tag === "textarea" || tag === "summary") return true;
    if (isEditable(el)) return true;
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    return el.hasAttribute("onclick");
  }

  function ownText(el) {
    let text = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    }
    return clean(text);
  }

  function controlText(el) {
    const own = ownText(el);
    if (own) return own;
    if (isInteractive(el) || /^h[1-6]$/.test(el.tagName)) {
      return clean(el.innerText || "");
    }
    return "";
  }

  function nameOf(el) {
    if (isSensitive(el)) return "[redacted]";
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
      if (text.trim()) return clean(text);
    }
    if ("labels" in el && el.labels?.length) {
      const text = [...el.labels].map((label) => label.innerText).join(" ");
      if (text.trim()) return clean(text);
    }
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return clean(placeholder);
    const alt = el.getAttribute("alt");
    if (alt) return clean(alt);
    const title = el.getAttribute("title");
    if (title) return clean(title);
    if (el instanceof HTMLInputElement) {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (["submit", "button", "reset"].includes(type) && el.value) return clean(el.value);
    }
    return controlText(el);
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    if (isEditable(el)) return "textbox";
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      if (["submit", "button", "reset"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "file") return "file";
      return "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "img") return "image";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "header") return "banner";
    if (tag === "footer") return "contentinfo";
    if (tag === "form") return "form";
    if (tag === "iframe") return "iframe";
    return tag;
  }

  function refFor(el) {
    const current = elToRef.get(el);
    if (current && refToEl.get(current) === el) return current;
    const ref = `e${++refCounter}`;
    refToEl.set(ref, el);
    elToRef.set(el, ref);
    return ref;
  }

  function elementFor(ref) {
    const el = refToEl.get(ref);
    if (!el || !el.isConnected) throw new Error(`Unknown ref ${ref}. Take a new snapshot.`);
    return el;
  }

  function describe(el) {
    const name = nameOf(el);
    const ref = elToRef.get(el) || refFor(el);
    return name ? `${roleOf(el)} "${name}" [${ref}]` : `${roleOf(el)} [${ref}]`;
  }

  function prune() {
    for (const [ref, el] of refToEl) {
      if (!el.isConnected) refToEl.delete(ref);
    }
  }

  function shouldInclude(el, filter) {
    const tag = el.tagName.toLowerCase();
    if (tag === "iframe") return true;
    if (isInteractive(el)) return true;
    if (/^h[1-6]$/.test(tag)) return true;
    if (["main", "nav", "header", "footer", "form"].includes(tag)) return true;
    const role = el.getAttribute("role");
    if (["navigation", "main", "banner", "contentinfo", "search"].includes(role || "")) return true;
    return filter === "all" && controlText(el).length > 0;
  }

  function renderLine(el, depth) {
    const bits = [`${"  ".repeat(depth)}${roleOf(el)}`];
    const name = nameOf(el);
    if (name) bits.push(`"${name.replace(/"/g, "'")}"`);
    bits.push(`[${refFor(el)}]`);
    if (el instanceof HTMLAnchorElement && el.getAttribute("href")) {
      bits.push(`href="${el.getAttribute("href").slice(0, 180)}"`);
    }
    const type = el.getAttribute("type");
    if (el instanceof HTMLInputElement && type) bits.push(`type="${type}"`);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder && !isSensitive(el)) bits.push(`placeholder="${clean(placeholder)}"`);
    if (el.disabled || el.getAttribute("aria-disabled") === "true") bits.push("disabled");
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") && el.checked) {
      bits.push("checked");
    }
    return bits.join(" ");
  }

  function snapshot(params) {
    if (!document.body) throw new Error("Page is not ready");
    prune();
    const filter = params.filter === "all" ? "all" : "interactive";
    const maxDepth = Math.max(1, Math.min(Number(params.depth) || 20, 40));
    const maxNodes = Math.max(50, Math.min(Number(params.maxNodes) || 800, 3000));
    const maxChars = Math.max(1000, Math.min(Number(params.maxChars) || 50000, 100000));
    const state = { filter, maxDepth, maxNodes, lines: [] };

    const root = params.rootSelector ? document.querySelector(params.rootSelector) : document.body;
    if (!root) throw new Error(`Nothing matches ${params.rootSelector}`);
    walk(root, 0, state, true);

    let lines = state.lines;
    if (params.query) {
      const needle = String(params.query).toLowerCase();
      lines = lines.filter((line) => line.toLowerCase().includes(needle));
    }
    let tree = lines.join("\n");
    let truncated = state.lines.length >= maxNodes;
    if (tree.length > maxChars) {
      truncated = true;
      tree = `${tree.slice(0, maxChars)}\n[truncated]`;
    }
    if (!tree) tree = params.query ? "(no matches)" : "(empty page)";
    const focus = document.activeElement ? elToRef.get(document.activeElement) || null : null;
    return {
      url: location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
      },
      focus,
      truncated,
      tree,
    };
  }

  function walk(el, includedDepth, state, isRoot) {
    if (!el || el.nodeType !== 1 || state.lines.length >= state.maxNodes) return;
    if (includedDepth > state.maxDepth) return;
    if (el.hasAttribute("data-cursor-chrome-ui")) return;
    if (!isRoot && isHidden(el)) return;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return;

    const include = shouldInclude(el, state.filter);
    if (include) {
      state.lines.push(renderLine(el, includedDepth));
      if (el instanceof HTMLSelectElement && !isSensitive(el)) {
        for (const option of [...el.options].slice(0, 40)) {
          const label = clean(option.textContent);
          state.lines.push(`${"  ".repeat(includedDepth + 1)}option "${label}"${option.selected ? " selected" : ""}`);
        }
      }
    }
    const next = include ? includedDepth + 1 : includedDepth;
    if (next > state.maxDepth) return;
    if (tag === "select" || tag === "svg" || tag === "iframe" || tag === "textarea") return;
    for (const child of el.children) {
      if (state.lines.length >= state.maxNodes) return;
      walk(child, next, state, false);
    }
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function frames() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  function mount() {
    if (ui?.host.isConnected) return ui;
    const host = document.createElement("div");
    host.setAttribute("data-cursor-chrome-ui", "");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .glow {
          position: fixed; inset: 0; pointer-events: none;
          box-shadow: inset 0 0 0 3px rgba(244,244,241,.9), inset 0 0 36px rgba(244,244,241,.16);
        }
        .pill {
          position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
          display: flex; align-items: center; gap: 10px;
          padding: 8px 8px 8px 14px; border-radius: 999px;
          background: #141414; color: #f4f4f1; pointer-events: auto;
          box-shadow: 0 10px 28px rgba(0,0,0,.28);
          font: 600 13px/1.2 ui-sans-serif, system-ui, sans-serif;
        }
        button {
          pointer-events: auto; border: 0; border-radius: 999px;
          background: #f4f4f1; color: #141414; cursor: pointer;
          font: 650 12px/1 ui-sans-serif, system-ui, sans-serif;
          padding: 6px 10px;
        }
        .cursor { position: fixed; left: 0; top: 0; overflow: visible; transition: transform 160ms ease-out; filter: drop-shadow(0 1px 1px rgba(0,0,0,.5)); }
        .ring {
          position: fixed; width: 28px; height: 28px; margin: -14px 0 0 -14px;
          border: 2px solid #f4f4f1; border-radius: 50%; pointer-events: none;
          animation: ring 450ms ease-out forwards;
        }
        @keyframes ring { from { opacity: .75; transform: scale(.35); } to { opacity: 0; transform: scale(1.4); } }
        @media (prefers-reduced-motion: reduce) {
          .cursor { transition: none; }
          .ring { animation: none; opacity: 0; }
        }
      </style>
      <div class="glow"></div>
      <div class="pill" role="status" aria-live="polite">
        <span>Cursor is working</span>
        <button type="button" aria-label="Stop Cursor">Stop</button>
      </div>
      <svg class="cursor" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path fill="#f4f4f1" stroke="#141414" stroke-width="1.2" stroke-linejoin="round" d="M4 2 L4 18 L9 14 L13 22 L16 20 L12 13 L19 13 Z"></path>
      </svg>
    `;
    const pill = shadow.querySelector(".pill");
    for (const type of ["pointerdown", "mousedown", "click"]) {
      pill.addEventListener(type, (event) => event.stopPropagation());
    }
    shadow.querySelector("button").addEventListener("click", (event) => {
      event.preventDefault();
      chrome.runtime.sendMessage({ type: "STOP" });
    });
    (document.documentElement || document.body).append(host);
    ui = { host, shadow, cursor: shadow.querySelector(".cursor") };
    return ui;
  }

  function unmount() {
    ui?.host.remove();
    ui = null;
  }

  function moveCursor(x, y) {
    const view = mount();
    view.cursor.style.transform = `translate(${x}px, ${y}px)`;
  }

  function pulse(x, y) {
    const view = mount();
    const ring = document.createElement("div");
    ring.className = "ring";
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    view.shadow.append(ring);
    setTimeout(() => ring.remove(), 450);
  }

  async function prepare(el) {
    if (!el.isConnected) throw new Error("Element is no longer on the page. Take a new snapshot.");
    el.scrollIntoView({ block: "center", inline: "nearest" });
    await frames();
    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    moveCursor(x, y);
    await wait(160);
    return { x, y };
  }

  function pointer(type, x, y, el) {
    el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window,
      pointerId: 1, pointerType: "mouse", isPrimary: true,
    }));
  }

  function mouse(type, x, y, el) {
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window,
      button: 0, buttons: type === "mousedown" ? 1 : 0,
    }));
  }

  async function click(params) {
    const el = elementFor(params.ref);
    if (el instanceof HTMLInputElement && el.type === "file") {
      throw new Error("File inputs can't be opened by the extension");
    }
    const { x, y } = await prepare(el);
    const top = document.elementFromPoint(x, y);
    pointer("pointerover", x, y, el);
    mouse("mouseover", x, y, el);
    pointer("pointermove", x, y, el);
    mouse("mousemove", x, y, el);
    pointer("pointerdown", x, y, el);
    mouse("mousedown", x, y, el);
    pointer("pointerup", x, y, el);
    mouse("mouseup", x, y, el);
    el.click();
    pulse(x, y);
    const host = ui?.host;
    const covered = top && top !== host && top !== el && !el.contains(top) && !top.contains(el);
    return { target: describe(el), x, y, covered: covered ? describe(top) : null };
  }

  function setNativeValue(el, value) {
    const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) throw new Error("This field can't be edited");
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function typeText(params) {
    const el = elementFor(params.ref);
    const text = params.text == null ? "" : String(params.text);
    await prepare(el);
    el.focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const next = params.clear === false ? `${el.value}${text}` : text;
      setNativeValue(el, next);
    } else if (el.isContentEditable) {
      if (params.clear !== false) document.execCommand("selectAll");
      document.execCommand("insertText", false, text);
    } else {
      throw new Error("This element can't be typed into");
    }
    return { target: describe(el), typed: isSensitive(el) ? "[redacted]" : text };
  }

  function parseCombo(combo) {
    const parts = String(combo || "").split("+").map((part) => part.trim()).filter(Boolean);
    if (!parts.length) throw new Error("key is required");
    const key = parts.pop();
    const mods = new Set(parts.map((part) => part.toLowerCase()));
    const code = /^[a-zA-Z]$/.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : key;
    return {
      key,
      code,
      bubbles: true,
      cancelable: true,
      ctrlKey: mods.has("ctrl") || mods.has("control"),
      metaKey: mods.has("meta") || mods.has("cmd") || mods.has("command"),
      altKey: mods.has("alt") || mods.has("option"),
      shiftKey: mods.has("shift"),
    };
  }

  async function pressKey(params) {
    const init = parseCombo(params.key);
    const el = params.ref ? elementFor(params.ref) : (document.activeElement || document.body);
    if (params.ref) await prepare(el);
    el.focus?.();
    if (init.key === "Backspace" && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !isSensitive(el)) {
      setNativeValue(el, el.value.slice(0, -1));
    }
    if (init.key === "Enter" && el instanceof HTMLTextAreaElement) {
      setNativeValue(el, `${el.value}\n`);
    }
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    if (init.key === "Enter" && el instanceof HTMLInputElement && el.form) {
      try {
        el.form.requestSubmit();
      } catch {
        // Some forms reject a synthetic submit. The key event still went out.
      }
    }
    return { target: describe(el), key: params.key };
  }

  async function hover(params) {
    const el = elementFor(params.ref);
    const { x, y } = await prepare(el);
    pointer("pointerover", x, y, el);
    mouse("mouseover", x, y, el);
    pointer("pointermove", x, y, el);
    mouse("mousemove", x, y, el);
    return { target: describe(el), x, y };
  }

  async function selectOption(params) {
    const el = elementFor(params.ref);
    if (!(el instanceof HTMLSelectElement)) throw new Error("This element is not a select");
    const wanted = String(params.value ?? "");
    const option = [...el.options].find((item) => item.value === wanted || clean(item.textContent) === clean(wanted));
    if (!option) throw new Error(`Option not found: ${wanted}`);
    await prepare(el);
    el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { target: describe(el), value: option.value, label: clean(option.textContent) };
  }

  async function scroll(params) {
    const dy = params.deltaY == null && params.deltaX == null ? 480 : Number(params.deltaY) || 0;
    const dx = Number(params.deltaX) || 0;
    let target = document.scrollingElement || document.documentElement;
    if (params.ref) {
      const el = elementFor(params.ref);
      await prepare(el);
      const style = getComputedStyle(el);
      const canScroll = /(auto|scroll)/.test(style.overflowY) || el.scrollHeight > el.clientHeight + 4;
      target = canScroll ? el : target;
    }
    target.scrollBy({ left: dx, top: dy, behavior: "auto" });
    return {
      deltaX: dx,
      deltaY: dy,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
    };
  }

  async function handle(message) {
    if (message.type === "working") {
      if (message.on) mount();
      else unmount();
      return { shown: Boolean(message.on) };
    }
    if (message.type === "snapshot") return snapshot(message);
    if (message.type === "click") return click(message);
    if (message.type === "type") return typeText(message);
    if (message.type === "press_key") return pressKey(message);
    if (message.type === "hover") return hover(message);
    if (message.type === "select") return selectOption(message);
    if (message.type === "scroll") return scroll(message);
    throw new Error(`Unknown page action ${message.type}`);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== "cursor-page") return;
    handle(message)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });
})();
