# Pi Dither

A dusty-pink, dithered workspace for **core Pi 0.85.1**: pixel typography, overlapping windows, and live multi-agent observers. A native macOS app, with the existing web and terminal interfaces preserved. No core Pi fork.

## macOS application — v0.4.0

Download **`Pi-Dither-0.4.0-macOS-arm64.zip`** from [Releases](https://github.com/JoeyZhuoer/pi-dither/releases), unzip it, and drag **`Pi Dither.app`** to Applications. Double-click to launch a native window—**no Terminal or external browser**. Node, core Pi and a pi-subagents fallback are bundled, and your normal Pi profile is used when present; no separate npm/Pi installation is needed to launch the app.

- **Apple Silicon, macOS 14+**. This build is **ad-hoc signed, not Developer-ID signed/notarized**; downloaded copies may require approval in macOS Privacy & Security. Do not disable Gatekeeper globally.
- Starts in your home directory. Select a project through **Windows → Workspace** before giving coding instructions, and pick the theme/desk colors or a photo point cloud through **Windows → Appearance** (or add windows back through the **⚙** settings button). Configure a provider through **Providers**, or use existing credentials from your normal `~/.pi/agent` profile. The archive contains no credentials; provider usage can incur charges.
- App sessions/preferences live in **`~/Library/Application Support/Pi Dither`**, not inside the bundle. Earlier checkout `.local` stores are not moved or deleted. Use **Sessions** to resume saved app conversations.
- Closing the native window hides it; the Dock icon or **View → Show Main Window** reopens it. **⌘Q** checks current work and shuts down owned Pi processes. Detached extension jobs may continue; finish/stop those jobs before quitting. View → Open App Data Folder opens Finder, not Terminal.
- External links cannot replace the privileged workspace; a native dialog offers to copy the URL. Native copy/paste and confirmation dialogs are supported.

Build locally with `npm run app:build`, then `npm run app`. Build prerequisites and lifecycle/security details: **[macOS documentation](docs/macos.md)**.

## Desktop features

- **Large main-agent window:** real Pi conversation, tools, streamed output/thinking, model selection, thinking controls, new session, stop, steering/follow-up queue, and reported usage.
- **Optional manual subagent windows:** startup no longer creates Scout/Review drafts. Use **+ Subagent** to create a draft, then **Launch** to start it. Each is a separate Pi session with selectable read-only tools. Closing frees its display number for reuse; minimizing does not. Insert a result into the main draft for review; it is never sent automatically.
- **Automatic delegate windows:** when main uses pi-subagents, display-only windows appear in the former Scout/Review positions on the right and update their available output/status. Closing one closes only the view, not the task; these windows never start duplicate agents or consume manual slots.
- **Window controls:** every window opens at its roomy default width with a medium height—main 610px, manual children 270px, delegated observers and utilities 400px—and can then be resized down to its floor: main 360×320 (a narrow column is fine), children 270×250, utilities/observers 400×320. No Auto-size button or menu command exists. The medium height follows the native-window/desktop height until you resize manually. Drag title bars, resize lower-right corners, and minimize to the taskbar. Your manual size/position and visibility are saved and survive hide/show, reload and future launches; mobile resizing does not overwrite desktop layouts. Arrange restores the compact presets, which open at the minimum width again when selected. Keyboard movement/resizing is included.
- **Usage diagram:** replaces the decorative glider with selected-agent token/cache bars, reported cost and context occupancy. Click its heading for details; unknown and provisional usage are clearly distinguished.
- **Markdown:** headings, emphasis, lists, tables, quotes, safe links, fenced code and copy-code buttons. Raw HTML and automatic remote images are disabled.
- **Feature windows:** use **Windows ▾** for Models & Reasoning, Providers, Workspace, Git & Worktrees, Usage, Sessions, Activity, and Tools. Drag, resize, hide/show, focus or arrange them; layouts and visibility are remembered. The separate Window Manager panel has been removed.
- **Pi packages:** the main agent loads every package configured in your normal Pi profile (`~/.pi/agent/settings.json`), so installed tools such as web search and pi-subagents' `subagent`, `bg_wait` and `subagent_supervisor` appear in the Tools window. The bundled pi-subagents copy is only a fallback when your profile does not configure one, so it never loads twice. Nothing is installed automatically and Pi settings are not changed; project-local `.pi` resources stay untrusted. Restart the app (or web-mode desktop server) after installing packages; reloading the interface alone does not reload extensions.
- **Tool selection:** choose built-in or package-provided tools per agent and explicitly Apply while idle. None disables all tools; manual desktop subagents cannot enable shell/write/delegation tools. Current selections survive new/clone, resume/workspace changes and provider reconnects without changing Pi defaults.
- **Appearance and photo:** the **Appearance** window holds the theme (chrome) colour, the ground colour and an optional photo. The photo is downscaled, stored locally, and turned into the **point-cloud background**: move the pointer to push or pull it and it springs back home when you leave. "Remove photo" and the two default buttons restore the plain look. Nothing is uploaded. Aggregated fleet activity is still reported to the UI (`#desktop[data-activity]`) and drives the activity window, but it paints nothing by itself.
- **Window settings:** the **⚙** button at the top right lists every window and controls the **bottom bar**: tick a window to keep its taskbar button, untick to hide it there (less frequent windows — models, providers, workspace, Git — start out of the bottom bar). Every window stays in the **Windows** menu, **Open** shows one immediately, and the choice is remembered.
- **Point-cloud pointer:** the photo cloud follows the reference field's motion — a spring back to each point's home position plus a signed `1/(1+d)²` force. **Cloud pointer** in the Appearance window switches it between **Push** (the reference default) and **Pull**; there is no other background-pointer interaction.
- **Particle field (optional):** on top of the photo cloud the Appearance window can add **Sparse / Normal / Dense** drifting particles. They link with faint lines and flash on collisions while they drift; the field itself has no pointer interaction. The layer pauses when the tab is hidden and draws a single static frame under reduced motion.
- **Session/workspace management:** browse and bookmark directories, switch workspace, view Git changes/diffs/worktrees, resume/rename/clone desktop sessions and archive/restore them without deleting transcripts.
- **Local-first:** authenticated loopback API, server-memory-only provider key overrides, no default Pi settings/auth changes, and disk-backed Pi sessions. The password field is cleared after submission; existing provider credentials are never returned to the browser.

The desktop is **not full terminal-feature parity** and does **not** attach to unrelated terminal or pi-subagents sessions. OAuth login, arbitrary custom-provider endpoint setup, image inputs and session-tree editing remain terminal features. Installed Pi packages load for the main agent; project-local `.pi` resources are still ignored. The supported `pi-subagents` integration observes the current main session's children through bounded status/transcript updates; its terminal FleetView and custom dialogs are not embedded. Async previews are polled, not guaranteed token-by-token streams. Session management is limited to desktop-owned sessions. Main-agent tools retain filesystem/shell access; this is not a sandbox. Project-local executable resources are ignored, and ambient extensions are disabled.

The main agent loads the packages configured in your Pi profile; the bundled pi-subagents fallback is used when the profile does not configure one. For an installation elsewhere, set `PI_DESKTOP_SUBAGENTS_ROOT=/absolute/package/directory`; `PI_DESKTOP_SUBAGENTS=0` disables all extensions for main. Nothing is installed automatically and global Pi settings are not changed. Tools shows the loaded packages, any load errors, and a missing-package notice.

Read [`docs/desktop.md`](docs/desktop.md) for architecture, security boundaries, tests, and limitations.

## Optional web development mode

`npm run desktop` (or legacy `Pi Desktop.command`) starts the original browser interface and does open a Terminal/browser. Use **Pi Dither.app** instead for the native experience. Web mode requires installed Node 22.19+ and core Pi 0.85.1:

```bash
npm run desktop
npm run desktop -- --project /path/to/project
```

Keep the authenticated local URL private. Ctrl+C stops that web server and its owned agents. No frontend npm dependency, bundler, React or CDN is required.

## Terminal interface — v0.1.0

The initial layout release includes a responsive workspace/engine header, a transcript section label, a persistent input strip, a static working marker, and the warm monochrome theme. It preserves core Pi's editor, transcript, tools, usage footer, warnings, and commands.

Requires **core Pi 0.85.1**, **Node.js 22.19+**, and a dark terminal background. No dependency installation is needed with an existing Pi installation.

On macOS, open `Pi Workstation.command`, or run:

```bash
cd /path/to/pi-dither
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

The follow-up native sizing/feature work, the plain-background removal and installed-package loading passed **116/116** Node/real-DOM tests, browser/WKWebView regressions, four terminal scenarios and rebuilt direct/Finder app launches. Automatic purpose-specific sizing, selective one-shot layout reset, normal package discovery for main, native Reload and bundle/source parity are covered. The verified build is installed locally; the follow-up source is published on `main`, while the public v0.4 release artifact is unchanged. See [the feature-by-feature audit](docs/native-feature-audit.md) for coverage and limitations.

```bash
npm test
npm run test:terminal
# On macOS, after building the application:
npm run test:macos
```

The unit/render tests use the installed Pi width helpers, schema, and theme loader. The PTY tests use temporary profiles without real provider credentials and exercise regular/fullscreen modes, 80×24 and 120×40, truecolor/256-color, layout toggling, shell output, reload, new sessions, resizing, and clean exit. No model prompts are sent. See `docs/validation.md` for coverage and remaining limitations.
