# Cursor Chrome browser remote control

Remote-control Chrome from Cursor. This is a Claude in Chrome alternative and a Claude Code extension alternative for people who already work in Cursor: a Chrome side panel, a visible working cursor, and a local bridge the agent uses to open tabs, click, type, and read pages.

Search terms: Cursor Chrome remote control, Cursor browser automation, Claude in Chrome alternative, Claude Code Chrome extension alternative, MCP Chrome bridge.

## What it does

- Opens pages, clicks, types, scrolls, and takes snapshots from Cursor
- Shows a “Cursor is working” indicator and a Stop button on the page
- Keeps agent tabs in one Cursor tab group and reuses that group when a new session starts
- Talks only to `127.0.0.1`. The bridge is not exposed on your network
- Lets you block URL patterns. There is no per-site approval prompt after the extension is connected

## How the bridge talks

Cursor does not control Chrome by itself. A small local bridge sits between them.

1. Cursor starts `cursor-chrome/bridge/server.mjs` from MCP settings. The bridge listens only on `127.0.0.1:39221`.
2. The first run writes a pairing token to `cursor-chrome/bridge/.token`. That file is the shared secret. It is not in this repository.
3. The Chrome extension long-polls the bridge. Cursor sends a browser command to the bridge, and the extension runs it in the open Chrome window.
4. The token is how the extension and the bridge recognize each other. A command without that token is rejected.

Nothing in this path is exposed on your LAN. Both sides have to be running on the same computer.

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

4. Reload Cursor so it starts the bridge. Confirm `cursor-chrome/bridge/.token` exists. It is one line, 64 hex characters, and the file mode is `0600`.

## Paste the token

The extension side panel is where you paste the token. Open it from the Cursor toolbar icon, or with Command+Shift+E on Mac and Ctrl+Shift+E elsewhere.

1. In the side panel, click **Open token file**. That opens [http://127.0.0.1:39221/token](http://127.0.0.1:39221/token), which shows the line from `cursor-chrome/bridge/.token`. The bridge has to be running or the page will not load.
2. On that page, click **Copy token**.
3. Back in the side panel, click **Paste**, or click the pairing-token field and paste with Command-V or Ctrl-V.
4. Click **Connect**.

Chrome stores the token locally after that. The status changes from “Not connected” to “Connecting”, then “Connected” once the bridge answers. If the bridge token file is replaced later, click **Paste a new token**, paste the new line, and connect again.

Leaving the field empty does not connect. The public extension does not ship a built-in token.

## Use it from Cursor

Ask Cursor to open a page, read it, and act on it. The agent calls tools on the local bridge: list tabs, navigate, open a tab, snapshot, click, type, press keys, scroll, and screenshot.

You should see a “Cursor is working” indicator on the page, with a Stop button. New tabs join an existing tab group named **Cursor** when one is already open. A new group is created only when none exists.

## Limits

The extension cannot control `chrome://` pages, the Chrome Web Store, or other restricted URLs. Password fields can be filled, and their values are not returned to the agent. Add a blocked pattern in the extension options for any site you do not want controlled.
