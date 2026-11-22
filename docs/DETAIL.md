# Interactive browser

A real Chromium, docked in the right Sidebar. Not a page preview, not an
iframe of a website: a browser running on a virtual display in the Harness
process's machine, streamed to the panel and controlled by whoever is looking
at it.

## Why it exists

Some work cannot be automated end to end. A site wants a password, an SMS
code, a QR scan from an authenticator app, or a confirmation only a person can
give. Automating those flows means handling secrets that should never travel
through a conversation.

This plugin inverts that: the browser comes to the person. The agent opens the
panel, the login screen appears beside the conversation, the user signs in
themselves, and the session stays alive in the panel for the agent to keep
working with.

## What you get

- **A tab in the right Sidebar** — open it from the guide ("Interactive
  browser"), or let it appear by itself when the agent starts the stack.
- **The real thing** — persistent browser profile, real cookies, real
  certificate handling, real 2FA and QR flows.
- **Same-origin delivery** — the panel is proxied through the Harness Web
  server, so it works behind HTTPS and is reachable from a remote browser. No
  separate port, no mixed-content block, no LAN address to discover.
- **One login, not two** — VNC needs no password here: both `x11vnc` and
  `websockify` listen on loopback only, and the only route in is the
  authenticated `/ibrowser/*` path. Opening the panel never asks for a second
  credential.
- **An agent tool** — `interactive_browser` with four actions:
  `open` (start the stack, optionally at a URL), `status`, `screenshot` (PNG of
  the virtual display), `close`.

## Usage

Ask the agent to open an interactive browser, for example while migrating data
out of a system that needs a human login. The panel starts, the agent's
`screenshot` action returns the same pixels you see, and you can sign in while
the agent waits.

The panel's toolbar has **Reconnect** (remounts the viewer without touching the
browser) and **Stop browser** (tears the whole stack down).

## Limits

- The display is 1440×900. Wide enough for most admin consoles; not a desktop
  for tile-hungry apps.
- Audio and file upload/download through the panel are not wired to the Host.
  Downloads land inside the virtual display's browser profile, not on your
  machine.
- One stack per Host. Starting it again reuses the running one.
- Clipboard between your machine and the panel depends on the VNC viewer's
  browser permissions.
- The panel needs `Xvfb`, `x11vnc`, `websockify` and `novnc` on the Host, and a
  Playwright installation able to launch Chromium.
