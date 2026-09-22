# Subagent inspection and retro comboboxes

## Goal

Expose each subagent's assigned/delivered prompt, tool calls, file-change evidence, token usage, monetary cost when reported, and elapsed time. Cover both manual read-only subagents and extension-delegated observer windows. Replace default-looking select controls with a consistent dusty-pink/gray, pixel-font combobox, including its open menu.

Implementation is local first. This request does not authorize a new public release, app installation/restart, or changes to existing conversations. A native app is currently listening on port 4317; leave it running and validate against isolated fixtures/profiles/ephemeral ports.

## Product behavior

- Keep the conversation/output primary. Add a compact inspection summary and expandable Prompt, Tools, Files, and Usage/time sections. Expanding details must not repeatedly focus, resize, reopen, or unminimize a window.
- Prompt means the task actually assigned to a delegate or latest delivered user prompt for a manual child—not system/developer instructions, queued-but-undelivered input, hidden reasoning, or credentials. Mark clipped upstream previews explicitly.
- Tools show bounded recent call names, safe argument summaries and known outcome; tool output remains in the existing transcript. Repeated snapshots replace cumulative data rather than inflate counts.
- Files show evidence attributable to that child. Successful write/edit observations and upstream changed-file reports have different provenance labels. A shared workspace Git diff, a read/search path, or a shell command string is not proof of a child's file changes. Unknown is not an empty verified list.
- Token/cost totals are reported values only. Distinguish zero, unavailable, partial/live and final; label manual session totals versus delegated child totals. Do not add provisional turn usage to cumulative totals or assign workflow aggregate cost to each child.
- Time is reported child duration or a duration measured from authoritative run-start/settlement events. No CPU-time claims; timestamps on inspection messages are not execution duration. Stop/failure/disconnection cannot leave a misleading forever-increasing timer.
- Comboboxes cover model, thinking, delivery and feature-window selectors. Preserve native select values/change semantics underneath, with an accessible themed trigger/listbox; no OS-default popup on the enhanced path. Support keyboard arrows/Home/End, Enter/Space, Escape, Tab, typeahead, pointer/touch, disabled/empty options, long model lists, safe text and viewport/window clipping. Native fallback must remain usable if enhancement cannot initialize.

## Frozen integration contract (inspection v1)

Both `agent.inspection` (manual children; main optional) and `delegation.inspection` use this additive DTO. Existing transcript fields and identity/lifecycle APIs remain compatible:

```js
inspection: {
  version: 1,
  prompt: { text: null, kind: 'task', truncated: false }, // kind: task | user
  tools: {
    availability: 'unavailable', // unavailable | partial | complete
    items: [], // { id, name, status, summary }; status: running | done | error | interrupted | unknown
    total: null, omitted: 0
  },
  files: {
    availability: 'unavailable', // unavailable | partial | complete
    items: [], // { path, action, evidence }; action: changed | added | deleted | unknown; evidence: observed-tool | reported
    omitted: 0
  },
  usage: {
    inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
    totalTokens: null, costUsd: null, scope: 'child', provisional: false // scope: child | session
  },
  timing: { startedAt: null, endedAt: null, durationMs: null, scope: 'run', live: false }
  // startedAt/endedAt: epoch milliseconds or null, never ISO strings.
  // durationMs: elapsed wall milliseconds or null, reported or measured from run events.
}
```

Numeric values are finite and nonnegative, counts are safe integers; missing/invalid numbers become `null`, not zero. UI prefers `durationMs` (label: Elapsed wall time); it may otherwise show a measured endpoint difference only with valid numeric endpoints and `endedAt >= startedAt`. Never extrapolate from the current clock or substitute last-activity timestamps. IDs and text are bounded. Cap prompt at 8,000 characters, tools at 40 items (600-character summaries), files at 64 paths (512 characters), and each inspection payload at 24 KiB. Keep the existing aggregate delegation budget (256,000 bytes) and omission notices. Redact known secrets and credential-shaped argument fields before clipping and before browser serialization; never forward arbitrary raw result/acceptance/artifact objects. Missing v1 metadata in an older backend must render as unavailable without breaking observers.

The backend owner implements normalization and provenance. The UI owner consumes this contract and only derives safe legacy fallbacks where source scope is clear. Any required contract change goes to the parent before either side diverges.

### Frontend seams

- Inspection lane adds `desktop/public/inspection.js` and `inspection.css`. Export `createInspectionPanel({ document, kind })` returning `{ element, update(inspection, { connected } = {}), destroy() }`. It may render a collapsed `<details>` shell or compact section controls; it owns bounded safe rendering and preserves expansion/focus across updates. This is display-only, with no API commands.
- That lane integrates the panel into `delegated.js`. Parent integrates the same panel into manual child windows in `app.js`; report exact hook points.
- Combobox lane adds `desktop/public/combobox.js` and `combobox.css`. Export `installComboboxes(root = document)` returning `{ refresh(), destroy() }`, and `syncCombobox(select)` for explicit programmatic value/option changes. Enhancement is document-scoped, idempotent, and works with dynamically created/removed controls without accumulating observers/listeners. Keep existing real `<select>` nodes, their names, values and change handlers as the control source of truth.
- Combobox lane wires `syncCombobox` into `features.js` where needed. Parent owns `app.js` initialization/value updates and HTML/CSS imports, static allowlist and native bundle file allowlist for both modules.

## Confirmed upstream capability boundary

The installed public inspect reply supplies task/messages/final output, but not usage or complete tool identities. Async status snapshots supply timestamps and tool counts, but not token/cost totals. Approved fallback: use exact-child usage only when a supported targeted status result actually returns it; otherwise show unavailable. Inspect-only tool previews remain partial with unknown outcomes. Changed files require correlated successful write/edit events or explicit child-reported paths (labeled reported, not verified). Do not parse free-form output into invented metrics, assign aggregate workflow usage to each child, read arbitrary artifacts, or extend installed upstream packages.

Hydrated/cloned/forked manual history cannot establish that the current child performed earlier writes. Keep historical tool previews partial, suppress observed-tool file evidence from hydration, retain explicitly session-scoped usage, and leave hydrated timing unavailable. Only live correlated successful events establish new observed-tool paths; an unavailable file list is not a verified empty result.

Baseline before integration: **106/106** Node/real-DOM tests passed, no skips. Three isolated implementation lanes and a subsequent fresh read-only review completed. Parent integrated their ownership-checked patches, applied the dispositions below and accepted the local source change after validation. Nothing has been deployed.

## Parent acceptance and review dispositions

- **P1, valid and fixed:** cached running counters must not become final when completed/paused/unknown updates contain no fresh authoritative child usage. Added direct and workflow transition tests; status-only async snapshots preserve provisional state too.
- **P2, valid and fixed:** DOM reconstruction/reparenting could retain a hidden select but discard its accessible trigger. Discovery/refresh now repairs the adjacency; real Chromium and WKWebView fixtures cover reconstruction, moves and no duplicate controls.
- **Capability correction accepted:** pi-subagents 0.69.0 replaces some foreground task fields with `[prompt redacted]`. Normalize it to unavailable, document the limitation, and do not bypass upstream redaction through artifact reads.
- Parent wired manual inspections, select synchronization, local CSS/modules, static routes and native source allowlists. Added browser-boundary redaction and retained existing transcript code/edit arguments rather than replacing them with inspector-only summaries. An additional compact-window fixture caught a summary shrinking out of reach at 325×310; a fixed minimum summary row and scrollable manual body preserve access without changing saved geometry.
- **Validation:** 129/129 Node/real-DOM tests, integrated Chromium synthetic desktop, standalone WKWebView component checks at 390px/1440px and all four terminal PTY scenarios passed. Fixed a missing fixture import route and removed a pre-existing 35ms timing assumption from the bridge test.
- **Residual limits:** some upstream prompts and async token/cost totals unavailable; no paid provider execution/billing test or exhaustive physical-touch/assistive-technology certification. New app archive/LaunchServices packaging not rerun. Installed app and user conversations untouched; local-only, no commit/push/release/install/restart.

## Assigned lanes

Pre-work baseline: public v0.4.0, commit `aa6ac6a41ed5eddcb7805d400e9032256b97a3ca`. Tracked checkout was clean; the unrelated untracked `docs/subagent-test.md` remains untouched and is not a lane input. Each writer gets a separate detached worktree at this exact baseline; private worktree/run mappings are recorded under ignored `.local`.

| Lane | Decision / exclusive ownership | Validation / handoff | Independence |
| --- | --- | --- | --- |
| Telemetry | `desktop/{inspection,delegations,delegation-bridge,protocol,pi-session,rpc-host}.mjs`; focused `tests/{inspection,delegations,delegation-live,desktop,tools,extensions}.test.mjs` only as needed | Map actual supported upstream fields; implement bounded/redacted DTO for manual/foreground/async/workflow cases; focused tests, limitations and source evidence | Backend/protocol only; no frontend/build/docs changes |
| Inspection UI | `desktop/public/{inspection.js,inspection.css,delegated.js}`; `tests/inspection-ui.test.mjs`, `tests/delegated.test.mjs` | Four inspection sections, scoped metrics and unknown/partial labels; safe/cumulative rendering and lifecycle tests; manual app integration hooks | Frozen DTO; no backend/app/global CSS edits |
| Combobox UI | `desktop/public/{combobox.js,combobox.css,features.js}`; `tests/combobox.test.mjs`, optional dedicated `tests/combobox-browser-checks.mjs` | Themed trigger and popup, keyboard/ARIA/typeahead/state synchronization/cleanup, narrow tests and integration hooks | Independent control component; no inspection/backend/app/global CSS edits |
| Fresh reviewer | Read-only across the three completed worktrees and managed handoffs | Evidence-backed P0/P1/P2 findings: telemetry truth/attribution/redaction, lifecycle, combo semantics/accessibility; no fixes | Separate fresh context; no mutation authority |
| Parent | Original checkout; integration, shared HTML/app/static/bundle wiring, docs and integrated browser/native validation | Inspect/accept lane diffs, reconcile review findings, run regression suite and report gaps | Sole integrator; owns publication/deployment decisions |

Children may edit only their owned worktree paths. No git staging/commits/pushes, nested delegation, package installation, global settings/credentials, existing app/session operations, or provider-backed desktop validation prompts. Read installed Pi/pi-subagents docs/source as needed but do not modify them. Escalate missing telemetry/contract/architecture decisions instead of inventing data or expanding execution authority.

## Gates

1. Backend: foreground and async/workflow identity continuity; reported zero/missing/partial/final usage; retries/reordered/cumulative snapshots; explicit truncation; redaction and malformed payloads; no cross-agent file attribution; bounded queues/polling; session replacement/stale IPC/disconnection/reset; manual read-only ceiling unchanged.
2. UI: prompt/tools/files/usage visible for both child kinds; unchanged output does not block metrics updates; malicious text inert; no duplicate records; expansion/scroll/focus/minimize/close persistence; old backend and unavailable evidence handled honestly.
3. Combobox: real selection changes reach existing handlers exactly once, programmatic updates stay in sync, disabled controls cannot mutate, open popup fits/clamps in desktop/mobile, keyboard/cancel/typeahead and focus restoration, dynamic teardown, no user text inserted as HTML.
4. Parent: full Node + opt-in real-DOM tests, integrated Chromium browser fixtures, terminal regressions, JS syntax/diff checks. Add isolated WKWebView validation where it can run without interfering with the live installed app; do not claim complete WebKit/assistive-technology certification from Chromium alone.
5. No deployment restart, public push or release in this implementation wave. Existing app data and ordinary Pi configuration remain unchanged.
