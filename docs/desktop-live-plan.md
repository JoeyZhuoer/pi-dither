# Live delegated windows, activity backdrop, and window presets

> Historical implementation record. No-publication restrictions below applied during that stage; the owner subsequently authorized the Pi Dither v0.4 release. Detailed run receipts and artifacts remain private. Current delivery: [macOS](macos.md).

## Request and scope

Implement the three requested features using isolated subagent lanes, then parent review/integration. Preserve all existing uncommitted v0.3 work, core Pi, manual read-only child permissions, saved sessions, tool selection, and running deployments. No commit/push/install or deployed-server restart. No live-provider validation prompts.

## Design

1. Observe pi-subagents work launched by the main session. Stable current-session run/child identities create display-only delegated windows automatically. Reconcile repeated cumulative updates; show available live transcript/output and terminal/error state. These are not new Pi processes, manual numbered slots, prompt destinations, or writable controls. Closing/minimizing an observer does not stop its task; do not continually reopen it. Fresh runs create new windows. Clear obsolete parent-session projections safely; reconnect snapshots rebuild observers without duplicating them.
2. Preserve the existing idle dither animation exactly. Add visibly distinct thinking and output patterns, with an explicit activity input. Aggregate connected manual agents and extension delegates from authoritative event state; prioritize output over thinking over idle. Tools/unknown busy work may use thinking visually but must not be labeled as verified model reasoning. Preserve bounded 12fps rendering, manual pause, reduced motion, hidden-tab suspension, resize behavior, and cleanup.
3. Provide explicit compact/default and working-size presets keyed by window purpose: main, manual child, delegated observer, models, providers, workspace, git, usage, sessions, activity, tools. Manual/saved geometry wins; viewport/mobile clamps never destroy preferred geometry. Arrange deliberately reapplies defaults. Avoid relying on the current generic utility size.

## Shared interface (v1)

Backend projects `agent.delegations` (bounded array, only main owns entries), with rows:

```js
{ id, runId, childId, name, source, status, phase, task, messages, finalOutput, error, updatedAt }
// id: opaque stable UI identity scoped to owning main session; never a numbered manual slot
// source: 'foreground' | 'async'
// status: queued|running|complete|failed|partial|paused|stopped|rejected|unknown
// phase: idle|thinking|output|tool|unknown
// messages: [{id, role, text, name?, status?}], bounded cumulative replacement, safe text
```

Optional `delegationStatus: {available, message, omitted}` explains unsupported/version/bounded telemetry. Never expose credentials, arbitrary raw details, or filesystem artifacts through this DTO. Monitor only current parent session. Keep extension hooks, native continuation and configured child policies unchanged. Main/manual agents gain `activityMode: idle|thinking|output|tool` from real core RPC events; reset correctly at settlement/session replacement/disconnect. No raw chain-of-thought is needed to classify activity.

Preferred backend seam: documented pi-subagents versioned extension event-bus RPC and RPC status/inspect widgets or normal tool-result updates. Check installed 0.69.0 protocol and Pi 0.85.1 public SDK. Never poll by sending model prompts, insert telemetry into conversation, tail arbitrary model-supplied paths, or modify installed packages. Discovery/inspect polling, if needed, must be bounded/non-overlapping, session-correlated, cleaned up, and read-only. Telemetry failures are nonfatal and reported truthfully.

Backdrop adds `setActivity('idle'|'thinking'|'output')` on the controller and accepts the same mode in deterministic drawing; frontend wires it after integration.

## Isolated ownership

Snapshots include the current dirty tree, not just HEAD; `.local` and secrets are excluded. One writer per snapshot; only parent integrates to the original checkout.

- **backend**: new delegation projection/bridge modules; `desktop/{rpc-host,pi-session,protocol}.mjs`; dedicated delegation tests and necessary existing backend tests. Own the DTO and activityMode. No frontend, package/docs, or running deployment changes.
- **observers**: `desktop/public/app.js`, new `delegated.js` module if useful, `styles.css`, dedicated observer tests. Implement automatic safe read-only windows from the above DTO and wire background aggregate through optional `setActivity`. No window engine, backdrop, backend, package/docs, or smoke-fixture changes.
- **visuals**: `desktop/public/{backdrop,windows}.js`, `tests/{backdrop,windows}.test.mjs`; add pure preset/activity tests if useful. No app, backend, shared style, package/docs changes.
- **parent**: plan, snapshot manifests, acceptance, integration, shared static allowlist, browser fixture/test additions, package scripts, documentation, full regression validation and fixes.

## Acceptance

- Test foreground cumulative updates, async discovery/inspect, stable keys, multiple children, errors, stale replies/session replacement, bounded/redacted output, no model-call side effects, lifecycle cleanup and unavailable telemetry.
- Test automatic creation, no duplicates, safe Markdown/text, live replacement/final result, hide/close behavior, no manual-slot collision, reconnect and old backend compatibility.
- Test activity selection/transitions and idle-equivalence, distinct pattern frames, pause/reduced-motion/hidden constraints and bounds.
- Test type-specific defaults/working sizes, persisted and manual overrides, Arrange, mobile restoration, and reasonable desktop layout.
- Run complete Node/real DOM and isolated fixture browser suites, syntax and diff checks. Real-Pi no-prompt management probes only. Actual paid delegation/live-provider completion remains explicitly unverified unless separately authorized.

## Progress

- Planning/source reconnaissance complete. Three independent snapshots of the full dirty tree, with backend, observer and visual ownership. Exact manifests and run receipts are retained privately.
- All three lanes completed. Parent checked exclusive ownership, empty staged diffs, and exact snapshot-baseline bytes before integrating 14 delivered paths. Previous files/patches preserved in `.local/live-integration-before/`; pre-existing v0.3 changes retained.
- Parent acceptance fixes: allowlisted the observer module; added public read-only live-transcript status reads so long async replies can update before message completion; resolved workflow keys using exact versioned child identities instead of display indexes; handled foreground workflow summaries with empty result arrays; preserved identity when an implicit async first child materializes; surfaced telemetry/omission notices and delegated activity counts.
- Completed validation: **99/99** Node/real-DOM tests, no skips; integrated fixture browser (including automatic windows, cumulative/final/error output, no duplicate sessions/API calls, minimize/close/reload, telemetry notices, session replacement, distinct sizes); isolated real-Pi browser with loaded extension and available telemetry, unchanged identity/messages/phase/queue/tools; four terminal PTY scenarios; all JS/MJS syntax checks and `git diff --check`.
- Explicit `test:desktop` script also passed 90 tests with its one opt-in real-DOM test skipped; the full 99-test run enabled that test. Baseline before integration: 71 passed/one opt-in skip.
- Evidence logs: `.local/live-{focused,node,browser,real-browser,terminal,desktop}-tests.log` and `.local/live-baseline-node.log`. Screenshots include `.local/desktop-delegated-fixture.png`, inspected locally.
- Durable child reports and the workflow receipt were retained privately. Mission closed completed after parent acceptance.
- No deployment restart, install, global setting/credential change, commit or push. Activation requires a safe desktop-server restart (not browser refresh alone), after finishing/stopping current work and extension jobs. Resume saved conversations through Sessions.

## Subsequent user-requested startup/placement and test-session cleanup

- Removed automatic Scout/Review drafts at startup and reconnect; retired their saved layout shells. **+ Subagent** still explicitly creates a manual draft.
- Delegated observers now use the former right-side Scout/Review vertical anchors and right-edge alignment, retaining their larger size presets. Untouched old defaults migrate; custom geometry and hidden state win. Observer position reservations are separate from manual slot numbers, reuse vacancies, and survive reload without moving survivors or assigning two views the same reservation.
- After checking the six app-owned root conversations, four derived child conversations, completed extension-run states, dead runner PIDs and absence of Desktop writers, removed those test sessions and their dedicated artifacts. Both default and preview desktop session stores are empty. Ordinary Pi history/current development session, settings and credentials were not touched. A metadata-only deletion receipt is private at `.local/session-cleanup-receipt.json`; the temporary prompt-content inventory was removed too.
- Validation: **102/102** Node/real-DOM checks; fixture and isolated real-Pi browser startup/reload/placement checks; syntax and diff checks. Logs: `.local/starter-removal-{focused,node,browser,real-browser}-tests.log`. All isolated validation data was removed; no paid desktop task was sent. No deployed server launch/restart, commit or push.

## Delivery boundaries

- Observers are display-only. Closing one suppresses its view in this tab; it does not stop its task. There is no separate reopen-closed-observer command; minimizing is reversible through the taskbar.
- Async output is a bounded polled preview, not guaranteed token-by-token streaming. Four children are inspected per cycle; at the 32-child cap a full rotation can take roughly twelve seconds plus read time. Missing/pruned artifacts or unsupported extension telemetry may limit output; timeouts stop polling until runtime replacement rather than accumulating work. Native continuation and detached-job lifecycle are unchanged.
- Main/child task status and restored tool selections remain authoritative. Background busy/thinking visuals are not a claim that hidden reasoning was observed.
- Validation did not launch paid desktop child tasks. Live provider streaming/billing/completion, exhaustive platform/accessibility coverage, and extension-native terminal dialogs remain unverified.
