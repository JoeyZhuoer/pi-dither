# Pi Desktop + Terminal UI

Two local interfaces for **core Pi 0.85.1**. The new desktop follows the supplied retro-computing reference: dusty pink, black stippling, pixel typography, and overlapping gray windows. The earlier terminal interface remains available.

## Desktop — v0.2.0

Open **`Pi Desktop.command`** on macOS, or:

```bash
cd /Users/admin/Projects/pi-terminal-ui
npm run desktop
# Optional: use a different working directory
npm run desktop -- --project /path/to/project
```

Requires Node.js 22.19+ and an existing Pi installation. No npm dependencies or hosted frontend are required. The launcher opens a private local URL; keep its token private. Stop the server with Ctrl+C in its Terminal window.

- **Large main-agent window:** real Pi conversation, tools, streamed output/thinking, model selection, thinking controls, new session, stop, steering/follow-up queue, and reported usage.
- **Smaller subagent windows:** start only when you press Launch. Each is a separate Pi session with read-only tools. Insert a result into the main draft for review; it is never sent automatically.
- **Window controls:** drag title bars, resize lower-right corners, minimize to the taskbar, and restore the default layout with Arrange. Keyboard movement/resizing and a stacked mobile layout are included.
- **Local-first:** loopback-only authenticated API, no browser-side provider keys, no default Pi settings changes, and disk-backed Pi sessions.

This browser release is **not full terminal-feature parity** and does **not** attach to existing terminal or pi-subagents runs. Arbitrary extensions, image inputs, session-tree/resume UI, login, and terminal-only commands are not implemented here. Main-agent tools retain filesystem/shell access; this is not a sandbox. Project-local executable resources are ignored, and ambient extensions are disabled.

Read [`docs/desktop.md`](docs/desktop.md) for architecture, security boundaries, tests, and limitations.

## Terminal interface — v0.1.0

The initial layout release includes a responsive workspace/engine header, a transcript section label, a persistent input strip, a static working marker, and the warm monochrome theme. It preserves core Pi's editor, transcript, tools, usage footer, warnings, and commands.

Requires **core Pi 0.85.1**, **Node.js 22.19+**, and a dark terminal background. No dependency installation is needed with an existing Pi installation.

On macOS, open `Pi Workstation.command`, or run:

```bash
cd /Users/admin/Projects/pi-terminal-ui
npm start
```

To use another project or an ephemeral session:

```bash
npm start -- --project /path/to/project
npm start -- --no-session
```

The launcher explicitly loads only this UI extension and theme; ambient extensions are disabled for this core-only release. Core skills, prompts, credentials, trust handling, and session persistence remain available. It neither installs a global package nor changes the saved theme. `--offline` disables startup network operations, **not** provider requests when you submit a prompt. No prompt is sent automatically.

If Pi cannot be found on PATH, set `PI_WORKSTATION_PI_ROOT` to its package directory. The launcher rejects untested Pi versions rather than silently claiming compatibility.

## Layout controls

| Command | Behavior |
| --- | --- |
| `/workstation compact` | Two-line startup header |
| `/workstation auto` | Adapt to terminal width and height |
| `/workstation ascii` | ASCII borders for owned UI |
| `/workstation unicode` | Restore box-drawing borders |
| `/workstation off` | Restore core header and spinner; remove input strip |
| `/workstation on` | Restore the layout |
| `/hotkeys` | Core Pi keyboard controls |
| `/quit` | Exit normally |

Layout preferences are session-runtime-only and reset on reload/new session. Turning the layout off leaves the current theme unchanged; use `/settings` to select a different theme. For a complete rollback, quit and launch ordinary `pi` without this launcher. No session migration is involved.

At 120×40, the startup header has workspace/engine columns. At 80×24 it becomes a compact panel; narrower/shorter windows reduce or hide decoration. These are header columns, **not docked transcript sidebars**. The startup header scrolls with the transcript and core clears it on `/new`; the input strip remains. No input or mouse events are intercepted.

The terminal owns its font and overall background. Theme styling and metadata are recomputed on render. Use `/reload` for source/theme-file changes; automatic watching of package theme files is not promised.

## Validation

```bash
npm test
npm run test:terminal
```

The unit/render tests use the installed Pi width helpers, schema, and theme loader. The PTY tests use temporary profiles without real provider credentials and exercise regular/fullscreen modes, 80×24 and 120×40, truecolor/256-color, layout toggling, shell output, reload, new sessions, resizing, and clean exit. No model prompts are sent. See `docs/validation.md` for coverage and remaining limitations.
