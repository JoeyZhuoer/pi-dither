# Pi Dither desktop 0.4.0

For the self-contained native macOS application (no Terminal/browser launch), installation, data locations and quit behavior, see [macOS](macos.md). The shared interface and optional web-server architecture are described below.

## Visual direction

Based on the user-supplied retro desktop reference (`截屏2026-09-19 16.54.12.png`): dusty pink desktop, black ordered dithering, dark title bars, light gray windows, compact pixel labels, a clock and a live usage diagram in place of the decorative glider. The original image is not redistributed. The bundled VT323 font is licensed under SIL OFL 1.1; see `desktop/public/assets/OFL.txt`.

The main agent has the largest agent window. Subagent windows are draggable, resizable within smaller bounds, minimizable, and closable. Window geometry and visibility stay in localStorage; transcripts and credentials do not. The clock is decorative. Startup does not create Scout/Review drafts. Manual drafts are created only through **+ Subagent**, and remain NOT STARTED until Launch. Subagent display numbers are reusable labels, separate from UUID/session identity: closing releases a number, minimizing does not, and surviving agents keep their numbers. The server resolves conflicting draft reservations from different tabs.

The dusty pink is user-controlled in the **Appearance** window: a theme colour paints the chrome (`--pink`) and a ground colour fills the desk, each with its own reset, plus a photo picker. A chosen photo is downscaled, stored in this browser profile, and painted as an ordered dither between the ground colour and the same dark ink used everywhere else, so it reads as part of the retro desktop. No photo means a flat ground, and there is no ambient pattern loop or motion preference; the only background animation is the short pointer ripple over the dots. Aggregated fleet activity (output over thinking/tool/unknown over idle) is still computed for the Activity window and exposed as `#desktop[data-activity]`, but it paints nothing.

The static background repaints only when a colour, the photo or the viewport changes (resize is debounced by 150 ms). The photo bitmap is **one cell per CSS pixel** (dots about 1px, painted as a single ImageData buffer), bounded to 4,000,000 cells and a 4096px edge, and cover-fits the window. Moving the pointer over the dots stirs them in the same spirit as the particle field: dots within a 26px radius slide outward and swirl around the cursor, `rippleLinks` fans faint 1px lines (blended into the region buffer) from the pointer to the nearest distinct inked dots within 90px, and the whole effect eases back over ~1 s to the exact base. Only the union of the affected sub-rectangles is repainted through `putImageData`.

On top of the ground and photo the Appearance window can enable an optional **particle field** (`pi-desktop:particles:v1`: off/sparse/normal/dense, up to 220 particles). Particles drift with a bounded speed band, bounce off the edges, link to neighbours within 90px with distance-faded lines, and collide elastically; each collision leaves a short expanding square flash. The pointer repels and swirls particles within 80px. The field has its own transparent canvas and one `requestAnimationFrame` loop that stops when the mode is off or the tab is hidden, and draws a single static frame when the system asks for reduced motion. Theme, ground and photo persist in the local website store (`pi-desktop:theme:v1`, `pi-desktop:ground:v1`, `pi-desktop:photo:v1`); the one-shot window-layout reset does not touch them.

The usage diagram follows the last selected real agent window, retaining that selection while utility/draft windows are focused. It shows reported session input/output/cache tokens, total tokens, cost and context occupancy. Token bars share a scale relative to the largest category; cache combines read and write. Unknown values remain `—`, zero is shown as zero, and provisional active-turn tokens are separate rather than added again to session totals. Disconnects mark the last reported data as offline. Click the diagram heading for detailed Usage. It uses existing SSE snapshots, without polling, model prompts or estimated activity; on mobile it appears beneath the stacked windows.

## Run the optional web development interface

```bash
npm run desktop
npm run desktop -- --project /absolute/project/path
# Without automatically opening a browser:
node desktop/server.mjs --project /absolute/project/path
# Change the local port:
PI_DESKTOP_PORT=4320 npm run desktop
# Keep a preview isolated from another running desktop's sessions:
PI_DESKTOP_PORT=4319 PI_DESKTOP_DATA_DIR=./.local/desktop-v03-preview npm run desktop
```

Alternatively, open `Pi Desktop.command`. Core Pi must be version **0.85.1**. `PI_WORKSTATION_PI_ROOT` overrides discovery. The exact-version gate is deliberate: protocol assumptions need revalidation before an upgrade.

Use the authenticated URL printed in Terminal. It binds to `127.0.0.1`, not all interfaces. `PI_DESKTOP_DATA_DIR` optionally isolates session/preference storage; do not run multiple servers or terminal writers against the same session files. Closing the browser does **not** stop agents; Ctrl+C in the server Terminal stops its desktop-owned Pi sessions. Extension-owned detached jobs may outlive their parent; finish or explicitly stop them with pi-subagents before shutting down or replacing the parent session. A server restart creates a new token and a new main session. Sessions are saved by Pi under `.local/desktop-sessions/` (gitignored), not resumed automatically by the frontend. Reopening or refreshing the browser while the same server runs reconnects to its existing agents.

## Feature windows

Use **Windows ▾** or the taskbar to show a feature. The **⚙** button at the top right is the window chooser: it lists every window, lets you tick which ones keep a button in the bottom taskbar (less frequent windows start out) and opens any window directly. Every window stays in the **Windows** menu, and the choice persists in `pi-desktop:taskbar:v1` (taskbar visibility is also stored per window in the layout). Utility close/minimize hides it without discarding its inputs. The separate Window Manager utility has been removed. Title-bar controls, the taskbar and Arrange still manage windows. Hiding never stops an agent.

New visible windows open at their roomy default width with a **medium height** (60% of the desktop, not below each kind's minimum): main 610px, manual children 270px, delegated observers and utilities 400px. Resizing is not capped at the opening size: main can be dragged down to a 360×320 column, children to 270×250 and utilities/observers to 400×320, and the narrower main window switches to compact typography and a wrapping model toolbar. Hidden windows open that way when shown. Auto-sized windows keep the minimum width and adapt their medium height when the native window or desktop container is resized. Manually adjusted windows and legacy custom layouts take precedence; repeated selections do not change them. Clicking a form field does not move controls under the pointer. **Arrange** restores the compact presets; selecting/opening those windows opens them at the minimum width again. Hiding/showing preserves position, size and main-window maximize/restore state. Temporary viewport constraints clamp only the visible rectangle, not the saved preference, so a mobile detour does not destroy the desktop layout. Reload retains geometry/visibility for existing live windows. Obsolete Scout/Review starter layout entries are removed; unsaved manual drafts are not restored.

Compact presets remain purpose-specific and are the Arrange/anchor geometry (width × height, before viewport constraints):

| Purpose | Compact / Arrange | Opening size |
| --- | --- | --- |
| Manual child | 325 × 310 | 270 × medium |
| Delegated observer | 560 × 430 | 400 × medium |
| Models | 700 × 540 | 400 × medium |
| Providers | 620 × 500 | 400 × medium |
| Workspace | 800 × 600 | 400 × medium |
| Git | 760 × 560 | 400 × medium |
| Usage | 560 × 420 | 400 × medium |
| Sessions | 680 × 520 | 400 × medium |
| Activity | 740 × 540 | 400 × medium |
| Tools | 600 × 480 |
| Appearance | 620 × 520 | 400 × medium |

Medium height is `round(desktop height × 0.6)`, never below the kind minimum (main 320, child 250, utility/delegated 320). Main opens at 610 × medium (never wider than the desktop) and stays resizable down to 360 × 320. Children grow leftward from their right-side anchors, with height bounded by the space below each anchor. Saved/manual rectangles take precedence over all of this and are kept. The native app also supports an explicitly requested, one-shot [window-layout reset](macos.md#reset-window-layout-only).

| Window | Controls |
| --- | --- |
| Models & reasoning | Select an agent, provider/model and supported thinking level; changes apply only to that agent's session |
| Providers | Inspect configured providers; set/remove a temporary API-key override with explicit idle-agent reconnect; no key validation request is sent |
| Workspace | Browse directories, bookmarks/recent roots, parent directory, confirmed workspace switch |
| Git & worktrees | Branch/HEAD, changed files, staged/unstaged text diff, linked worktrees; open a worktree as workspace |
| Usage | Per-session and all-agent view, token/cache breakdown, cost, context occupancy, message/tool counts; provisional active-message usage shown separately |
| Sessions | Desktop-owned saved and active sessions; search, new, resume, rename, clone, archive/restore |
| Activity | Actual run/tool/retry/queue history, timestamps, focus and stop; recovered queued text remains available to copy |
| Tools | Select a target agent and tools from its runtime catalog; explicit Apply, select-none/all, authoritative active selection |

Tool changes require a connected, idle target with empty steering/follow-up queues. Choose tools in the Tools window or an agent's **Tools** shortcut, then explicitly Apply; checkbox edits alone do nothing. None genuinely disables all agent tools. Draft subagents offer read/grep/find/ls checkboxes before Launch. Missing metadata means unavailable, not no-tools; unknown or disallowed names are rejected before mutation/spawn. A custom draft selection cannot silently fall back to wider defaults when metadata becomes unavailable.

Tool choices are runtime-only, not saved defaults or transcript entries. The current selection carries through new/clone, workspace/resume and provider replacement. Restarting the server starts a fresh main with core defaults plus the loaded packages' defaults, rather than restoring a saved session's historical tool selection.

Workspace/session/provider transitions require idle agents and empty queues. API command acceptance is serialized across tabs. Browser commands carry workspace-context and agent-session preconditions, so stale tabs are rejected rather than silently sending into a replacement session. New runtimes are initialized before replacing the old fleet; failed startup retains the original. Workspace switches start a fresh main and close desktop subagents; saved sessions remain available. Resume restores the selected session's cwd and active-branch transcript. Sessions from ordinary terminal Pi are not imported or attached automatically. Archive is desktop preference metadata only, not file deletion. Empty sessions may not yet have a persisted file; the UI lists active ones but requires persistence before resuming them.

Provider overrides are private bootstrap data passed to each Pi subprocess on fd 3 and applied with the SDK's `ModelRuntime.setRuntimeApiKey`. They are not placed in argv, environment variables, browser storage, repository files or global auth. Keys are held in server/child memory until replaced or stopped, and existing credentials are never returned to the browser. These protections do not make the browser profile, host processes or main-agent tools a sandbox. OAuth and custom endpoint configuration remain terminal-managed. A configured key is not proof of provider validity; real requests may fail or incur costs.

Assistant Markdown supports a bounded common subset, not full CommonMark. Generated DOM supports headings, nested lists/task lists, emphasis, quotes, tables, safe explicit links, code fences and copy-code buttons. Raw HTML remains text; images are placeholders. Reference-style links, autolinks and some delimiter/indentation edge cases remain literal. User/tool text stays literal.

## Automatic delegated observers

When main invokes pi-subagents, its child identities automatically create **DELEGATED / … · Observer** windows in the former right-side Scout/Review positions. The first two use the original vertical anchors and right-edge alignment while retaining the larger observer size preset. Hidden observers retain their positions; closed/vanished views free positions without renumbering or moving survivors. Untouched old observer defaults migrate from the utility-window area; manually adjusted layouts remain unchanged. Foreground progress and async status/inspection update these read-only previews, including available live output, saved messages, final reports and failures. Workflows are shown by child, not as fake agent windows for workflow containers or host CI steps. Repeated snapshots replace output instead of duplicating windows. The taskbar distinguishes active delegated work from manual agents.

These views do not launch a new Pi process or reserve a manual display number. They have no prompt, tools, model or stop controls. **Minimize** keeps the task running and can be undone through the taskbar. **Close** suppresses that observer for the same parent/context in this browser tab, including reload when sessionStorage is available; it does not stop the extension job. There is currently no separate reopen-closed-observer command; use the main extension's status tools. Reconnecting rebuilds current views without duplication; replacing the parent clears its old projections, not the detached jobs themselves.

Status is polled serially about every 1.5 seconds, with up to four child inspections/live tails per cycle. This is bounded near-live observation, not guaranteed token-by-token delivery; 32 children can require roughly twelve seconds plus read time for a complete rotation. Public versioned identities route workflow keys to exact runs rather than guessing array indexes. No telemetry prompt or conversation entry is sent. A four-second telemetry operation timeout stops further polling for that runtime rather than accumulating uncancellable work; the main conversation remains usable. Main shows interrupted/unsupported telemetry and omitted-entry notices. Replacing the runtime reinitializes monitoring.

Previews are capped at 32 children, 40 messages per child, 2,000 characters per message, 8,000-character final output, and roughly 256 KB of projected rows. Full results remain extension-owned. Only the current main session is observed; unrelated terminal jobs are not attached. Installed Pi 0.85.1 and pi-subagents 0.69.0 management/protocol behavior was checked without paid child execution.

## Subagent inspection and retro dropdowns (local, unreleased)

The development checkout adds a collapsed **Inspection** panel to manual child and delegated observer windows. Expand **Prompt**, **Tools**, **Files**, or **Usage + time**; output stays primary. Cumulative metric updates preserve section expansion, focus, scroll and window geometry, even when the output is unchanged. The inspector is display-only. Compact manual windows keep a reachable summary row and scroll the body if necessary, without enlarging saved geometry.

- **Prompt:** assigned task where exposed, or the manual session's latest saved/delivered user text. Never queued-undelivered input, system instructions or hidden reasoning. Pi-subagents 0.69.0 redacts some foreground task fields; its `[prompt redacted]` marker is shown as unavailable. Async task previews can already be truncated upstream.
- **Tools/files:** bounded recent calls and safe summaries, with unknown outcomes distinguished from success. Only exact-ID successful write/edit observations or explicit child-reported paths count as change evidence. Reported paths are not verified diffs; shared Git changes, shell strings and read paths are excluded. Cloned/hydrated manual history cannot establish current-child file changes.
- **Usage/time:** reported child totals or explicitly labeled manual session totals. Missing values stay unavailable; zero stays zero. Status alone cannot turn cached progress counts into final billing. Async inspect/status often lacks tokens/cost. Time is reported duration or valid settled run endpoints, not a ticking estimate or last-activity timestamp. No workflow-wide usage is copied to each child.

Inspection is limited to 8,000 prompt characters, 40 tool previews (600-character summaries), 64 paths (512 characters), and 24 KiB per DTO, inside the existing 256,000-byte delegation envelope. Credential-shaped text is redacted before clipping and again at display time. Unavailable v1 metadata in an older backend clears prior details instead of inventing values.

Model, thinking, delivery and feature selectors now have square beveled gray/pink triggers **and themed open menus**, with local VT323 typography. Native select values and change handlers remain authoritative. Arrows/Home/End navigate, Enter/Space commits, Escape/Tab cancels tentative changes, typing searches, and pointer selection works. Menus are viewport-clamped and support long lists, disabled/empty states and dynamic reconstruction. Teardown restores the native fallback.

This change is included in the rebuilt and tested [native auto-size follow-up](native-feature-audit.md), installed locally after explicit approval. The public v0.4 release artifact remains unchanged; the follow-up source lives on `main`. See [inspection-wave validation](validation.md#local-inspectioncombobox-acceptance-unreleased).

## Architecture

- `desktop/server.mjs`: dependency-free Node HTTP server, static allowlist, authenticated command API, state snapshots over fetch-based SSE, command request IDs, and agent process ownership.
- `desktop/pi-session.mjs`: one isolated Pi process per real agent; LF JSON framing, response correlation, persisted transcript hydration, bounded activity/usage projection and process-group cleanup.
- `desktop/rpc-host.mjs`: installed Pi's public SDK runtime and unchanged `runRpcMode` protocol. This allows true non-persisting credential overrides without replacing core agent/tool/session behavior. A separate private Node IPC channel uses public SDK tool catalog/selection APIs; stdin/stdout core RPC and fd-3 bootstrap stay unchanged.
- `desktop/controls.mjs` and `workspace.mjs`: transactional fleet replacement, directory/bookmark management, core SessionManager listings/renames, archive metadata, and read-only Git inspection. Git helpers disable hooks, fsmonitor, clean/process filters, external diff and textconv; large outputs are bounded.
- `desktop/extensions.mjs`: the main agent loads every package configured in the profile through the normal resource loader (global settings only, project untrusted). It returns an explicit path only for the bundled/`PI_DESKTOP_SUBAGENTS_ROOT` pi-subagents fallback used when the profile does not configure its own, so the package never loads twice. No automatic installation; `PI_DESKTOP_SUBAGENTS=0` disables extensions for main. Package/extension load failures are reported in the Tools status instead of failing the app.
- `desktop/tools.mjs` and `subagent-slots.mjs`: strict runtime tool selection/read-only ceilings and reusable server-owned display numbers.
- `desktop/delegation-bridge.mjs` and `delegations.mjs`: session/generation-correlated, bounded read-only extension bus/status/inspect bridge and child DTO. No arbitrary artifact-path reads, duplicate runners, or transcript writers. Private IPC coalesces backpressure; temporary provider keys are redacted before clipping and again at the server boundary.
- `desktop/inspection.mjs`: bounded inspection DTO normalization, redaction, tool/file evidence, scoped usage and timing.
- `desktop/public/inspection.js` and `combobox.js`: shared display-only inspector and native-select-backed themed menus; corresponding local styles are explicitly served and bundle-allowlisted.
- `desktop/public/delegated.js`: automatic observer reconciliation, safe bounded rendering, close suppression and aggregate activity selection, separate from manual agent API targets.
- `desktop/protocol.mjs`: streaming state reducer with event-derived thinking/output/tool/idle activity. `agent_end` is not considered settled; `agent_settled` handles retry/continuation completion. Tool partial results replace cumulative output rather than appending duplicates.
- `desktop/public/`: vanilla modules, local CSS/font, Canvas stippling, accessible title-bar controls, window layout and conversation views. No CDN, bundler, React dependency, or public network service.

The main agent defaults to core read/bash/edit/write plus the tools provided by the installed packages it loaded (for example web search, and pi-subagents' `subagent`, `bg_wait`, `subagent_supervisor` under its configuration). Available tools come from the SDK catalog and expose only name/description; the main catalog admits every loaded tool. A manual desktop subagent window is created with only `read,grep,find,ls` (or an explicitly selected subset, including none), no delegation extension, a read-only system instruction, and its own session. Those windows cannot write. Agents launched through the main agent's `subagent` tool instead follow pi-subagents' configured permissions, limits and workflow policies; they can include writers. **This is a tool restriction, not an OS sandbox or protection against reading sensitive files.** Subagents share the working directory and may observe main-agent edits while inspecting it. For manual desktop windows there is no automatic parent/child transcript sharing or launch; Handoff inserts the latest completed assistant result into the main editor and the user decides whether to send it. Extension-delegated jobs are separate: their normal tool output and visible completion messages appear in the main conversation, and native completion may trigger a continuation. They now get separate automatic observer windows/taskbar entries, not manual numbered sessions. Its terminal FleetView, custom dialogs and inspector UI are not embedded; use the extension's text tools for status/control. Unsupported confirmation dialogs are cancelled, never automatically approved.

The SDK host sets `PI_OFFLINE=1`, creates its model runtime with network catalog refresh disabled, and uses `SettingsManager.create(...,{projectTrusted:false})`. For main it loads resources normally, so profile packages (and their extensions/skills/commands/themes) load; the bundled pi-subagents path is added only as a fallback. Subagent windows keep `noExtensions:true` and their read-only tools. Project `.pi` resources remain untrusted. The extension's own configured child runtimes follow its normal policies. This preserves offline catalog startup and the untrusted-project host boundary, not a tool-execution approval mechanism. Global Pi provider configuration/auth and ordinary skills/prompts remain available. Custom providers implemented by disabled extensions are not supported. Model/thinking selection uses non-persisting RPC defaults.

## Security and execution behavior

- The API checks exact Host, Origin when present, Fetch Metadata, and a random bearer token. No wildcard CORS, cookies, URL query auth, public listener, or proxy support.
- The launch token starts in the URL fragment, is moved to sessionStorage, and is removed from the address bar. It is not embedded in served assets. Keep the printed URL private. Use a trusted browser profile: same-origin code with access to the token can operate the main agent's tools.
- Only selected model metadata crosses to the browser; provider keys, custom headers, and base URLs are not included in model responses. Tool output can still contain sensitive data the user/agent reads.
- Assistant messages are rendered by a bounded DOM-building Markdown parser, never by interpreting provider HTML. User and tool output remain text. Link schemes are allowlisted; no automatic navigation or remote images.
- Mutating requests require IDs and are deduplicated within a bounded 256-entry server cache. This is not durable exactly-once execution. Lost acknowledgments do not trigger automatic resend. Inspect the transcript before manually retrying.
- Stop clears queued messages before aborting and returns pending text to the draft. Closing a **manual desktop subagent** terminates its process. Closing a **delegated observer** only dismisses the view and does not stop its extension-owned task. Minimizing either does not terminate work.
- At most six manual desktop subagents plus the main agent. Extension-delegated jobs have their own pi-subagents limits. Browser history is bounded to 160 recent projected entries / roughly one million displayed characters; individual outputs are truncated. Pi's session files remain the full record. Large image/tool attachments are not forwarded to the browser.
- SSE reconnects with a complete current snapshot, not token-by-token replay. Backpressured clients are disconnected rather than allowed to exhaust server memory. Browser-tab drafts survive a reconnect, but are not persisted across page reloads.

## Validation

```bash
npm test
npm run test:terminal
# Enable feature-window and inspection/combobox real-DOM suites:
CHROME_PATH='/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' PI_DESKTOP_FEATURE_BROWSER_TEST=1 PI_COMBOBOX_BROWSER_TEST=1 npm test
# Isolated WKWebView components; does not launch/restart Pi Dither.app:
npm run test:webkit
# Integrated desktop browser suite:
CHROME_PATH='/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' npm run test:browser
```

`CHROME_PATH` can point to another Chromium executable. The script defaults to Chrome on macOS. This machine's Chrome headless startup failed with `FATAL:base/path_service.cc:264 Failed to get the path for 1001`; Edge's Chromium engine successfully ran the browser suite. No browser installation or default-browser changes were needed.

Completed checks:

- Latest local native sizing/feature audit: **116/116** Node/real-DOM checks, integrated Chromium, isolated WKWebView, four terminal scenarios, and a rebuilt relocated app through direct/Finder launches passed. Includes minimum-width/medium-height opening geometry, saved manual sizes, hide/reopen, Reload with lost cached auth, the plain background, and normal package discovery for the main agent. See the [feature-by-feature audit](native-feature-audit.md); the follow-up source is published on `main`, but no new release artifact exists.

- Local inspection/combobox follow-up: **129/129** Node/real-DOM checks, integrated synthetic desktop browser, isolated WKWebView at 390px and 1440px, and four terminal PTY scenarios passed. No provider prompts, installed-app restart or deployment. See [validation](validation.md) for limitations.
- Historical starter-removal/right-side placement follow-up: **102/102** Node/real-DOM checks passed without skips, plus the integrated fixture and isolated real-Pi browsers (no model prompts or saved-conversation changes). Startup/reload no longer create empty children; explicit manual drafts, observer anchoring, old-default migration, custom layout preservation and freed-position reuse across reload are covered.
- Live-window integration milestone: 99/99 Node/real-DOM checks passed without skips. Added delegation status/inspect and live-tail fixtures, stable workflow identities and materializing first-child regression, bounded/redacted projections, timeout/disposal and stale-generation coverage, observer close/minimize/reload behavior, activity precedence, unchanged idle-pattern goldens, and distinct window preset/layout tests. Credential-free installed-package probes check actual status/inspect handlers, zero prompt insertion, new-session reset, and preserved empty tool selection. The integrated fixture browser checks automatic windows, live cumulative replacement, final/error state, telemetry notices, no duplicate process/API calls, safe rendering, close suppression, parent replacement and distinct sizes.
- Previous extension milestone: 72 tests passed with the opt-in browser flag: terminal/API/Markdown/window-engine baselines, usage diagrams, feature-controller and real-DOM checks, Git/activity/control races, 11 backdrop lifecycle tests, tool selection/IPC/real-Pi lifecycle checks, and reusable slot allocation/API tests. The four extension regressions cover local/disabled/missing discovery, entry provenance and child ceilings, visible/hidden custom messages and safe notifications, plus the installed extension's RPC defaults and none/subset persistence across new/clone/resume. A separate credential-free SDK process executes the actual installed `subagent` management/list tool without launching a child or calling a model. Settings/credential bytes remain unchanged. Without the browser flag, that one real-DOM test is explicitly skipped; the installed-extension regression also explicitly skips if the package is absent.
- Browser fixture: real 1440×960 rendering; token removal; largest-main hierarchy; pointer drag; keyboard resize; minimize/taskbar restore; Arrange; explicit subagent launch with a selected tool subset; main extension-tool visibility and explicit selection; no delegation option in read-only child catalogs; none/all/subset Apply without prompts; unavailable-metadata guard; closed-number reuse and hidden-slot occupancy; no legacy manager shell; evolving/paused/reduced-motion Canvas and persisted pause; safe hostile-text rendering; unsent handoff; clickable usage diagram and selected-agent telemetry; auto-zoom; hide/show/reload layout preservation; 390px mobile layout without horizontal overflow or loss of desktop preferences; no frontend exceptions/resource/CSP errors.
- Same non-mutating browser layout/control checks against an isolated **real Pi** main session on an ephemeral port, temporary data/profile and stripped Pi environment; identity, phase, messages and active tools unchanged. No deployed server restart or live prompts. An initial concurrent attempt with a stripped browser environment timed out at CDP navigation; a serial retry with the normal browser environment and still-isolated Pi environment passed.
- Four terminal PTY scenarios passed unchanged.
- Actual core RPC startup, model catalog, thinking levels, session identity and usage verified. Installed-Pi tool tests verify none/all/subset, read-only ceiling, stale session/revision rejection, queued-message rejection, new/clone/resume/workspace/provider preservation, IPC exit cleanup, and unchanged initialized temporary settings/credential/session bytes when changing tools. New controls exercised real Pi resume/rename/clone/archive/restore/workspace/provider flows using temporary profiles and seeded transcripts, with no model prompts. Failure/race tests verify an old fleet is not replaced on failed startup and a concurrent prompt cannot enter the wrong workspace. Existing provider credentials were not returned to the browser.
- Screenshots captured and visually inspected locally under `.local/desktop-live.png` and `.local/desktop-fixture.png`. Screenshots are not tracked.

**Not certified:** live model streaming/billing, real-provider child completion/key validity, tool cancellation side effects, retry/compaction under provider failures, concurrent queued prompts, large-session behavior, Safari/Firefox, screen-reader behavior, IME, image input/output, extension UI dialogs, exhaustive trust/session workflows, or non-macOS process cleanup. Streaming/retry transitions have reducer tests; that is not end-to-end provider certification.

Use `Pi Workstation.command` / `npm start`, or ordinary core Pi, for the original terminal workflow and missing browser features. No core fork or default theme change is required.
