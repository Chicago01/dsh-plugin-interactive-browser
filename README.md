# dsh-plugin-interactive-browser

A real Chromium on a virtual display, docked in the DeepSeek Harness right Sidebar.

Not a page preview, not an iframe of a website: a browser running on the Host,
streamed into the panel, controlled by whoever is looking at it.

## Why

Some work cannot be automated end to end. A site wants a password, a code from
an SMS, a QR scan from an authenticator app, or a confirmation only a person can
give. Automating those flows means handling secrets that should never travel
through a conversation.

This plugin inverts that: the browser comes to the person. The agent opens the
panel, the login screen appears beside the conversation, the user signs in
themselves, and the session stays alive in the panel for the agent to keep
working with.

It is also useful when there is no API at all — a legacy admin console where the
agent can watch the screen and the user presses the buttons.

## What you get

- **A tab in the right Sidebar.** Open it from the guide, or let it appear by
  itself once the agent has started the stack.
- **The real thing.** Persistent browser profile, real cookies, real certificate
  handling, real 2FA and QR flows. Anything a normal Chromium can do.
- **Same-origin delivery.** The panel is proxied through the Harness Web server,
  so it works behind HTTPS and is reachable from a remote browser. No separate
  port to expose, no mixed-content block, no LAN address to discover.
- **One login, not two.** VNC needs no password here: `x11vnc` and `websockify`
  both listen on loopback only, and the only route in is the authenticated
  `/ibrowser/*` path.
- **An agent tool.** `interactive_browser` with four actions: `open` (start the
  stack, optionally at a URL), `status`, `screenshot` (PNG of the virtual
  display), `close`.

## Architecture

```
Xvfb :99 -> Chromium (persistent profile) -> x11vnc 127.0.0.1:5900
                                                 |
                                           websockify 127.0.0.1:6080
                                                 |
                      /ibrowser/*  (same-origin proxy on ctx.webServer)
                                                 |
                            iframe in sidebar.right.pane.tab
```

Serving through the Harness Web server rather than pointing the iframe at `:6080`
fixes two separate problems: an HTTPS page cannot frame an HTTP origin, and
`192.168.x.x:6080` is unreachable from a remote browser.

## Requirements

On the Host that runs DeepSeek Harness:

- `Xvfb`, `x11vnc`, `websockify`, `novnc` (Debian/Ubuntu:
  `apt install xvfb x11vnc websockify novnc scrot`)
- `scrot` for the `screenshot` action
- A Playwright installation able to launch Chromium. The plugin finds one by
  itself in most DSH deployments; if it cannot, set `IBROWSER_PLAYWRIGHT` to a
  Playwright package directory, or set `playwrightPaths` in the config.

DSH `^0.2.3-alpha.1`.

## Install

The plugin is a bundle. Install it through the Harness plugin manager with this
directory as the target, or use **Plugins → Add plugin** in the Web UI and pick
the local directory.

Enabling it adds the **Interactive browser** tab type to the right Sidebar.

## Usage

Open the right Sidebar and pick **Interactive browser** from the guide, or ask
the agent to open an interactive browser. The panel starts the stack, and the
agent's `screenshot` action returns the same pixels you see.

The panel's toolbar has **Reconnect** (remounts the viewer without touching the
browser) and **Stop browser** (tears the whole stack down).

## Configuration

Every field is optional; the row in `cordis.patch.yml` can override them:

```yaml
- insert:
    - id: interactive-browser
      name: 'dsh-plugin-interactive-browser'
      config:
        vncPort: 5900
        webPort: 6080
        display: ':99'
        screen: '1440x900x24'
        startUrl: 'https://example.com'
        playwrightPaths: []
```

| Key | Default | Meaning |
|---|---|---|
| `display` | `:99` | X display the stack runs on |
| `screen` | `1440x900x24` | Virtual screen geometry |
| `vncPort` | `5900` | x11vnc port, loopback only |
| `webPort` | `6080` | websockify port, loopback only |
| `startUrl` | `https://example.com` | Page loaded when the browser starts |
| `playwrightPaths` | `[]` | Extra Playwright package directories to try |
| `xvfbBin` / `x11vncBin` / `websockifyBin` / `scrotBin` | binary names | Override the executables |
| `novncWeb` | `/usr/share/novnc` | Static noVNC assets |

## Security model

- Exactly one lock: the Harness session on `/ibrowser/*`. `x11vnc` runs with
  `-nopw` and `websockify` binds `127.0.0.1`, so neither port is reachable from
  outside the Host.
- Mutating routes (`/api/start`, `/api/stop`) require `POST`, so a cross-site
  `GET` cannot manipulate the stack.
- The proxy rejects paths containing `..`.
- The browser profile lives under `$DSH_HOME/interactive-browser/profile` and
  holds whatever you logged into. Treat it as a credential store.

## Limitations

- The display is a fixed virtual screen; there is no audio and no clipboard
  bridge beyond what the VNC viewer itself supports.
- Downloads stay inside the virtual display's browser profile, not on your machine.
- One stack per Host; `open` reuses a running stack.
- The panel auto-opens once per page load when the stack is already alive. Close
  it and it stays closed until the page reloads.

## 中文要点

右侧栏里放一台真 Chromium。遇到要账号密码、短信验证码、钉钉/企微扫码的站点时，
登录界面直接出现在对话旁边，你亲手操作，agent 接着干。

安装：Plugins → Add plugin，选这个目录。系统依赖：
`apt install xvfb x11vnc websockify novnc scrot`。

只保留 DSH 一层鉴权：x11vnc 和 websockify 都只听 127.0.0.1，VNC 不设密码，
所以面板不会第二次问你要密码。

## License

MIT
