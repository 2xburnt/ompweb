# ompweb

[![npm version](https://img.shields.io/npm/v/@kahme247/ompweb.svg?logo=npm&color=e05d44)](https://www.npmjs.com/package/@kahme247/ompweb)
[![node version](https://img.shields.io/node/v/@kahme247/ompweb.svg?logo=node.js&color=44cc11)](https://nodejs.org)
[![license](https://img.shields.io/github/license/kahme247/ompweb.svg?color=44cc11)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@kahme247/ompweb.svg?color=44cc11)](https://www.npmjs.com/package/@kahme247/ompweb)
[![GitHub stars](https://img.shields.io/github/stars/kahme247/ompweb.svg?logo=github)](https://github.com/kahme247/ompweb/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/kahme247/ompweb/pulls)

[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md)

Community: [Join the OMPWEB Discord](https://discord.gg/evqgGzRfM5)

A clean, modern web UI for the [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) coding agent. It reads your local omp sessions and gives you a browser workspace to chat with the agent, browse projects, manage settings, and preview files.

![ompweb — live session demo](docs/demo.gif)

<details>
<summary>Screenshots (light / dark)</summary>

![ompweb — light theme](docs/screenshot-light.png)

![ompweb — dark theme](docs/screenshot-dark.png)

</details>

## Requirements

- Node.js `>= 22.19.0` on the machine that serves the web UI
- [omp](https://github.com/can1357/oh-my-pi) on every machine you want to drive: on the serving machine itself (on `PATH` or via `OMP_WEB_OMP_BIN`) and/or on remote machines reachable over SSH (see [Machines](#machines-remote-first))

## Quick Start

**Run directly without installing:**

```bash
npx @kahme247/ompweb@latest
```

**Or install globally:**

```bash
npm install -g @kahme247/ompweb
ompweb
```

Open [http://127.0.0.1:30177](http://127.0.0.1:30177) in your browser.

### CLI Options

```bash
ompweb --port 8080                         # Custom port
ompweb --hostname 0.0.0.0                  # Listen on network
ompweb --password "your-password"          # Enable password protection
ompweb --no-open                           # Don't auto-open the browser
ompweb --install-tray                      # Install Windows System Tray service & Desktop shortcuts
ompweb --uninstall-tray                    # Uninstall Windows System Tray service & shortcuts
ompweb --tray                              # Start background System Tray manager
ompweb --help                              # Show help
ompweb --version                           # Show version
```

### Run as a Windows Service (System Tray)

Install ompweb as a Windows background service with a system tray icon and autostart at login:

```bash
ompweb --install-tray
```

Manage it from **Settings → System & Updates → Windows Background Service**, or via CLI:

```bash
ompweb --tray          # Start the tray manager
ompweb --uninstall-tray
```

Shortcuts are created on the Desktop and Start Menu. The service restarts automatically and shows the current port and status in the tray.

### Run as a macOS Service (launchd)

Install ompweb as a launchd user agent that starts at login and restarts on crash:

```bash
npx --yes @kahme247/ompweb@latest ompweb-launchd install
```

Manage it with:

```bash
npx --yes @kahme247/ompweb@latest ompweb-launchd status      # Show service state
npx --yes @kahme247/ompweb@latest ompweb-launchd uninstall   # Stop and remove
```

The service runs `npx --yes @kahme247/ompweb@latest`; pass a package spec to pin a
version, e.g. `ompweb-launchd install @kahme247/ompweb@0.3.6`. All
[environment variables](#environment-variables) are read at install time and baked
into the plist, plus `OMP_WEB_PKG` (package spec, same as the positional argument).
As a service, the browser is **not** auto-opened by default — install with
`OMP_WEB_NO_OPEN=0` to restore that.

```bash
OMP_WEB_PASSWORD=secret npx --yes @kahme247/ompweb@latest ompweb-launchd install
```

When binding to a non-loopback host, require authentication (`OMP_WEB_PASSWORD`
or equivalent access control) and HTTPS through a trusted reverse proxy or VPN.
Never expose the unauthenticated web UI or send its password/session cookie over
plaintext HTTP.

Logs go to `~/Library/Logs/ompweb/ompweb.log` and the plist lives at
`~/Library/LaunchAgents/com.kahme247.ompweb.plist` (mode 600; a configured
password is stored there in plain text).

## Machines (remote-first)

ompweb is a hub for the machines that run `omp`. Every machine is a **host**: the
computer serving the UI is the `local` host, and any other computer you can
reach over SSH is an `ssh` host. Sessions, projects, files, git, settings,
models, skills and plugins are all read from and written to the machine that
owns them — nothing is mirrored or cached on disk on the hub, so a small hub
(a mini PC, a VM) can front machines with large session histories.

Remote machines need only `omp` and a POSIX shell with the usual coreutils
(`find`, `stat`, `head`, `tail`, `gzip`, `git` for repository features). No
Node.js or Bun is required there. The hub keeps one multiplexed OpenSSH
connection per machine (`ControlMaster`), so commands cost a round trip, not a
handshake. Authentication is whatever your `~/.ssh/config` provides (keys, an
agent such as 1Password's, jump hosts); connections are non-interactive
(`BatchMode=yes`), so password prompts are not supported.

Machines are configured in `~/.omp-web/hosts.json` (override the directory
with `OMP_WEB_HOME` or the file with `OMP_WEB_HOSTS_FILE`) and managed from
**Settings → Machines** in the UI. Example:

```json
{
  "version": 1,
  "defaultHost": "workstation",
  "hosts": [
    { "id": "workstation", "name": "Workstation", "kind": "ssh", "enabled": true,
      "ssh": { "host": "workstation.example", "user": "you", "port": 22 },
      "ompBin": "omp", "agentDir": "~/.omp/agent", "defaultCwd": "~/work" },
    { "id": "local", "name": "This machine", "kind": "local", "enabled": true }
  ]
}
```

- `ssh.host` may be an alias from `~/.ssh/config` (a Tailscale MagicDNS name works well).
- `ompBin` and `agentDir` are optional; `omp` is looked up on the machine's `PATH` (plus `~/.local/bin`, `~/.bun/bin`, `/usr/local/bin`, `/opt/homebrew/bin`) and the agent dir defaults to `~/.omp/agent` there.
- Disable the `local` host (`"enabled": false`) for a pure hub that only fronts remote machines.
- A missing `hosts.json` means the classic single-machine setup: just the local host.

Every host-scoped API route accepts `?host=<id>` (or an `x-omp-host` header);
session routes derive the machine from the session id.

### Updating a git checkout

When ompweb runs from a git checkout (this repository), the in-app update
check compares your branch with its tracked remote (`git fetch`) instead of
the npm registry, shows the pending commits, and "Update and restart" runs
`git pull --ff-only && npm ci && npm run build` before restarting. The npm
package is never installed over a checkout. Under systemd, add
`Environment=OMP_WEB_SERVICE=<unit>.service` to the unit so the updater can
stop and start the service; the worker runs in a transient `systemd-run` unit
and restores the previous build if a step fails. A checkout with uncommitted
changes refuses to update until they are committed or stashed.

## Features

- **Interactive Chat**: Real-time streaming conversation with your local `omp` agent — tool calls, thinking levels, token counts, cost, context gauge, queue controls, and interrupt & retry.
- **Session Management**: Browse past conversations by project, fork sessions, branch within a session, archive/restore, import session files, and deep-link via URL.
- **Live Plans & Subagents**: Collapsible panels pinned above the composer track live todo phases and running subagents (status, tool, retries, tokens/cost, nested tasks) with transcript dialogs and history recovery.
- **Tool Preset Picker**: Choose the toolset for new sessions in the composer — `none` / `default` (`read,bash,edit,write`) / `full` (all tools including subagents). Persists to localStorage.
- **File Explorer & Previews**: Browse workspaces side-by-side with chat; preview code, markdown, Mermaid, images, audio, PDFs, and diffs with allow-listed access.
- **Git Worktree Support**: Create, switch, and manage Git worktrees directly from the sidebar; sessions and file roots stay grouped by project.
- **Usage & Analytics**: Dashboard in **Settings → Usage** for tokens, costs, cache savings, and breakdowns by provider / model / day / project with SQLite persistence.
- **Windows System Tray & Service**: Background service, tray icon, logon autostart, and Desktop/Start Menu shortcuts (Windows).
- **macOS launchd Service**: LaunchAgent that starts at login, restarts on crash, and logs under `~/Library/Logs/ompweb`.
- **Web-based Settings** (8 tabs): Interface & Behavior, Safety & Approvals, AI Model Defaults, API Keys & Providers, Usage, Agent & Intelligence (advisor, memory, compaction), Agents, Extensions & Tools (MCP, skills, plugins), System & Updates.
- **Slash Commands & Shortcuts**: Quick prompts (`/plan`, `/review`, `/fix`, `/test`, etc.), `⌘K` / `Ctrl+K` palette, and model/reasoning cycling.
- **UI Themes & Localization**: Warm paper light/dark themes, chat font size & interface scale, with full English, Chinese (简体中文), and Japanese (日本語) translations.

## Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | Server port | `30177` |
| `OMP_WEB_HOSTNAME` | Server bind host | `127.0.0.1` |
| `OMP_WEB_PASSWORD` | Optional password for web login | _None (auth disabled)_ |
| `OMP_WEB_NO_OPEN` | Set to `1` to prevent auto-opening browser | `0` |
| `OMP_WEB_OMP_BIN` | Path to `omp` binary if not on `PATH` | _auto-detected_ |
| `PI_CODING_AGENT_DIR` | Custom omp agent directory (local host) | `~/.omp/agent` |
| `OMP_WEB_HOME` | Directory for ompweb's own state (`hosts.json`, SSH control sockets) | `~/.omp-web` |
| `OMP_WEB_HOSTS_FILE` | Path to the machines configuration | `$OMP_WEB_HOME/hosts.json` |

## Development

```bash
git clone https://github.com/kahme247/ompweb.git
cd ompweb
npm install
npm run dev
```

The dev server runs at [http://127.0.0.1:30178](http://127.0.0.1:30178).

### Checks

```bash
npm run typecheck   # Type check (TypeScript)
npm run lint        # ESLint
npm test            # Run test suite
```

> **Note**: Do not run `npm run build` during local dev — it populates `.next/` and can break `npm run dev`.

## License & Credits

- Forked from [agegr/pi-web](https://github.com/agegr/pi-web) (MIT) and adapted for [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi).
- Released under the [MIT License](./LICENSE).
