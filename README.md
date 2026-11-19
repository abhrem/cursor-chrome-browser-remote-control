# Cursor Chrome browser remote control

Remote-control Chrome from Cursor. This is a Claude in Chrome alternative and a Claude Code extension alternative for people who already work in Cursor: a Chrome side panel, a visible working cursor, and a local bridge the agent uses to open tabs, click, type, and read pages.

Search terms: Cursor Chrome remote control, Cursor browser automation, Claude in Chrome alternative, Claude Code Chrome extension alternative, MCP Chrome bridge.

## What it does

- Opens pages, clicks, types, scrolls, and takes snapshots from Cursor
- Shows a “Cursor is working” indicator and a Stop button on the page
- Keeps agent tabs in one Cursor tab group and reuses that group when a new session starts
- Talks only to `127.0.0.1`. The bridge is not exposed on your network
- Lets you block URL patterns. There is no per-site approval prompt after the extension is connected

## Install

1. Open `chrome://extensions`, turn on Developer mode, and choose **Load unpacked**.
2. Select the `cursor-chrome` folder in this repository.
3. In Cursor, add the bridge to `.cursor/mcp.json`. Use the absolute path to Node and to `server.mjs` on your machine:

```json
{
  "mcpServers": {
    "cursor-chrome": {
      "command": "node",
      "args": ["/absolute/path/to/cursor-chrome/bridge/server.mjs"]
    }
  }
}
```

4. Reload Cursor so it starts the bridge. The first run writes a pairing token to `cursor-chrome/bridge/.token`.
5. Open the extension side panel (Command+Shift+E on Mac, Ctrl+Shift+E elsewhere) and paste that token. Chrome stores it locally after that.

The token file is mode `0600` and is not part of this repository. Do not commit it.

## Use it from Cursor

Ask Cursor to open a page, read it, and act on it. The agent calls tools on the local bridge: list tabs, navigate, open a tab, snapshot, click, type, press keys, scroll, and screenshot.

New tabs join an existing tab group named **Cursor** when one is already open. A new group is created only when none exists.

## Limits

The extension cannot control `chrome://` pages, the Chrome Web Store, or other restricted URLs. Password fields can be filled, and their values are not returned to the agent. Add a blocked pattern in the extension options for any site you do not want controlled.
