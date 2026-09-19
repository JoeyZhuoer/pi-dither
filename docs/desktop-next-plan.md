# Desktop follow-up: tools, reusable agent numbers, flowing background

> Historical implementation record. Publication restrictions below applied at that stage and were superseded by the authorized Pi Dither v0.4 release. Internal run receipts remain private; see [macOS](macos.md) for current delivery.

Status: implemented and validated locally on `feat/desktop-v03`. Parallel implementation authorized by the user; no commits or publication of this follow-up. The prior uncommitted work and terminal interface are preserved.

## Subsequent extension repair

The user subsequently requested the installed pi-subagents extension in the main agent. This explicitly supersedes the original main-agent no-extension/default-tools scope below; manual desktop windows remain read-only. The host now allowlists the installed package's entry points, exposes its SDK tools, and restores selections after dynamic supervisor registration. Tools reports availability; visible extension messages and notifications reach the browser. Four added regressions bring the opt-in suite to **72 passing tests**, with installed-package management execution and no model prompts. See `desktop.md` for startup configuration and terminal-UI/background-job limitations. An isolated real-Pi browser pass also confirmed the extension active while leaving session identity, messages and tools unchanged. Repair logs: `.local/extensions-{focused,node,browser,real-browser}-tests.log`. The running desktop was not restarted and no changes were pushed.

## Scope and invariants (original follow-up)

- Remove the **Window Manager utility panel**, not the underlying window engine. Retain title-bar controls, layout memory/auto-zoom, taskbar and Arrange. The Windows menu remains a feature launcher.
- Add a **Tools** panel with per-agent available-tool checkboxes and explicit Apply. Main defaults remain core Pi's read/bash/edit/write; available built-ins come from the runtime. Subagents can select only subsets of read/grep/find/ls. No arbitrary/custom extensions are enabled. An empty selection really disables all agent tools.
- Tool selection is a session-runtime setting, never a global-settings or credential write. Preserve selections through new/clone, provider reconnect, and workspace/resume transitions rather than silently widening them. New children start with the read-only default unless an explicit subset is supplied before Launch.
- Tool changes require the target to be connected, idle, with no queued messages. Reject unknown names, malformed requests, stale context/session commands, and attempted subagent privilege widening. Tool access restrictions are not an OS sandbox.
- Display numbers use the lowest free positive subagent slot. Closing releases it; hiding/minimizing does not. Draft-to-live conversion keeps its number where available. UUID identity remains separate from display numbering. No transcript/session file deletion or renumbering of surviving agents.
- Animate the pink pixel/dither background gently; bounded canvas size/work and frame rate, no network/data simulation, stop animation in hidden tabs, honor dynamic reduced-motion preferences, and offer a pause/resume button in Help.
- Preserve existing terminal interface and running desktops on 4318/4319. No live provider prompts in validation. Do not restart a server without inspecting agent state; do not attach independent servers or concurrent writers to the same session files. Existing short-lived idle candidates for transactional replacement under the serialized control lock remain permitted; no new rollback/copying subsystem is in scope.

## Parallel ownership

Original delivery checkout, branch `feat/desktop-v03`, published base `7c1aaa4559ba3ceb4ee3599ec051b91c8d03cb61`, with previous uncommitted v0.3 work preserved. Each lane is an independent clean snapshot repository; the parent alone integrates into the delivery checkout. Children do not commit, push, install packages, spawn agents, or operate deployed desktops.

| Lane | Isolated cwd | Decision / owned files | Gate / handoff | Independence |
| --- | --- | --- | --- | --- |
| Backend | Separate backend snapshot | Enforced tool catalog/selection via public SDK; `desktop/{server,pi-session,rpc-host,controls,protocol}.mjs`, optional `desktop/tools.mjs`, `tests/tools.test.mjs` | Focused unit/API + isolated real-Pi no-prompt tests; managed report with changed paths/commands/risks | No frontend or display-number ownership |
| Panels | Separate panels snapshot | Remove Window Manager, add Tools panel; `desktop/public/{features.js,features.css,index.html}`, `tests/features.test.mjs` | Controller/real-DOM tests; managed report | Fixed state/endpoint contract; no backend/app/window engine edits |
| Background | Separate background snapshot | Animation/lifecycle; `desktop/public/backdrop.js`, `tests/backdrop.test.mjs` | Deterministic animation, pause, reduced-motion, resize and disposal tests; managed report | No app/CSS/backend edits |
| Parent | Original delivery checkout | Number reuse, draft tool selection, animation wiring, integration, docs and browser regression suite | Read every lane diff; full tests, terminal and browser checks; no publish | Only delivery-checkout writer |

## Shared contracts

### Tools

Agent snapshot fields:

```js
availableTools: [{ name: 'read', description: '...' }], // allowed ceiling, not raw schemas/paths
activeTools: ['read'],
```

Absent/null fields mean unsupported/unavailable, not an empty selection. An empty `activeTools: []` is valid and visible. Populate from the actual SDK; don't fabricate an enabled-state UI. Frontend does not expose unavailable tools or infer subagent elevation. Stable checkbox drafts survive unrelated SSE/usage changes but reset on actual selected-agent/session/catalog/active-set changes.

`POST /api/agents/:id/tools` accepts `{tools: string[]}` plus existing requestId/contextId/sessionId preconditions. Return authoritative `{availableTools, activeTools}` and publish state. Existing serial acceptance must also cover this action. `POST /api/agents` optionally accepts `tools: string[]` and validates it against the read-only ceiling **before spawning or prompting**. Omitted selects the existing read-only default.

Use public `AgentSession.getAllTools()`, `getActiveToolNames()`, `setActiveToolsByName()`, `isIdle` and queue metadata, not direct agent-state mutation. Core RPC has no tool-selection commands. Preferred bridge: an additional private Node IPC channel between PiSession and rpc-host, leaving fd-3 credentials and core stdin/stdout RPC untouched. Validate again in the SDK host, correlate responses, handle child exit/timeouts, and prevent stale metadata responses from rolling back newer selection state. Preserve current selection in the runtime factory and during candidate/provider/context replacements.

`features.open('tools', agentId?)` may target an agent (optional second argument for parent shortcuts). UI test IDs: `feature-tools`, `tools-agent`, `tools-apply`, `tools-current`; checkbox IDs/testids should include tool name. Keep existing installFeatureWindows API and usage-diagram exports. Remove `windows` from TITLES, menu, controller and tests; don't remove `DesktopWindows` or its events. Add Help button `id="background-motion"`, `type="button"`, initial text `Pause background motion`, `aria-pressed="false"`; parent owns behavior.

### Background

Keep backward-compatible `drawBackdrop(canvas, timeSeconds = 0)` for one frame. Add `startBackdrop(canvas, {paused = false, onStateChange} = {})` returning `{setPaused(boolean), destroy()}`. The controller owns resize/reduced-motion/visibility/page lifecycle and a single animation loop. Callback payload: `{paused, running, reducedMotion, hidden}`; paused is the user preference, not document visibility. Invoke on state changes, not each frame. Parent replaces its old resize listener/draw call with this controller and persists manual pause independently. Cap frame rate at roughly 10–15fps and drawing cells to a reasonable bound (~100k or less); avoid flashes, document input interception and continuing timers while hidden/reduced-motion/paused.

## Acceptance

1. No Window Manager panel/menu/task, including when legacy layout contains a visible `windows` entry. Other window controls still work.
2. Tools selection really affects SDK active tools; none/all/subset work, core default unaffected until explicit Apply, no implicit prompts or global writes. Read-only ceiling and stale/busy/queued checks are tested server-side.
3. Close slot 1 then create reuses 1. Hidden slots remain occupied, launches preserve slots, removed survivors are not renamed, reload doesn't blindly increment forever.
4. Pattern visibly flows with time; pause/system reduction/hidden tab halt work; resize doesn't create extra loops; dispose cleans listeners.
5. Full Node suite (real-DOM option), integrated synthetic browser checks, four terminal scenarios, isolated real-Pi no-prompt control checks. Preserve deployment conversations; report any gaps honestly.

## Integration and evidence

All three lanes were reviewed and integrated by the parent. Two lanes completed while the backend worker timed out after 1,200,000ms before writing its report. The parent captured and inspected its partial diff/untracked files privately, then resumed that same retained worker. Recovery completed with a 16-test focused rerun and the backend handoff; no new lane or execution-mode fallback was used. Durable lane reports and exact run receipts remain private.

Parent integration adds authoritative slots/names to creation/state and preserves slots during provider replacement; UUIDs remain unique. Browser drafts reserve only local numbers, reconcile collisions with actual agents, and inherit layout on launch. Tools shortcuts, prelaunch subsets, unavailable-state rendering and a no-silent-fallback guard complement the lane's Tools panel. Legacy manager layout entries are retired without changing the window engine.

Acceptance evidence:

- **68/68 tests passed, no skips**, with `PI_DESKTOP_FEATURE_BROWSER_TEST=1` and Edge Chromium: `.local/next-node-tests.log`. Includes authoritative installed-Pi none/all/subset selection, private-channel/stale/queue guards, transition preservation, slot reuse/collision checks and deterministic motion lifecycle tests.
- **Integrated fixture browser passed**: `.local/next-browser-tests.log`. Covers removal of a legacy visible manager shell, checkbox selection/explicit Apply, prelaunch subset, unavailable metadata without tool widening, hidden slot occupancy, closed draft/live number reuse, starter-slot reload, animated/pause/reduced-motion frames, pause persistence, existing usage/window/mobile behavior and no frontend/CSP errors.
- **Isolated real-Pi browser passed**, no prompts: `.local/next-real-browser-tests.log`. A temporary profile/data directory and ephemeral port were used; session identity/phase/messages/active tools remained unchanged. One initial concurrent navigation attempt timed out with a stripped browser environment. The serial retry retained the normal browser environment while keeping the Pi environment stripped and isolated.
- **Four terminal PTY scenarios passed**: `.local/next-terminal-tests.log`.
- Node syntax and `git diff --check` passed. Startup/feature screenshots were inspected locally; artifacts are private and ignored.

No paid prompts, global-default/credential changes, independent writers to deployed sessions, server restarts, commits or pushes were performed. Final passive checks found ports 4318 and 4319 not listening and their previously observed PIDs absent; neither was relaunched. Start the updated desktop when ready, then explicitly resume a saved session if desired.

Residual limits: live-provider streaming/billing/key validity and real paid child completion remain uncertified; busy/queue/IPC behavior has no-prompt fixtures and SDK tests, not exhaustive provider execution. Tool allowlists are not an OS sandbox. Cross-platform, non-Chromium and accessibility certification remain incomplete. Extra unsaved drafts are not restored on reload. GitHub `main` remains the separately authorized v0.2 release.
