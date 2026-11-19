const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "file:"]);

export function assertControllable(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("URL is not valid");
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`This URL can't be controlled: ${url}`);
  }
  return parsed;
}

export function grantKey(url) {
  const parsed = assertControllable(url);
  if (parsed.protocol === "file:") {
    const directory = parsed.pathname.replace(/[^/]+$/, "");
    return `file://${directory}`;
  }
  return parsed.origin;
}

export function sitePath(url) {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./i, "") + (parsed.port ? `:${parsed.port}` : "");
  let path = parsed.pathname || "/";
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return (host + path).toLowerCase();
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function patternToRegExp(pattern) {
  let text = String(pattern).trim().toLowerCase();
  text = text.replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (text.length > 1 && text.endsWith("/") && !text.endsWith("/*")) {
    text = text.slice(0, -1);
  }
  if (!text || text === "/*") return null;
  if (!text.includes("/")) text += "/*";
  const source = text.split("*").map(escapeRegex).join(".*");
  return new RegExp(`^${source}$`);
}

export function blockedBy(url, patterns) {
  let target;
  try {
    target = sitePath(url);
  } catch {
    return null;
  }
  for (const pattern of patterns || []) {
    const expression = patternToRegExp(pattern);
    if (expression && expression.test(target)) return String(pattern).trim();
  }
  return null;
}
