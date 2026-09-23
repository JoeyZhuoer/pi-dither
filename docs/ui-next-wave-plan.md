# Next UI wave — thinking back in-window, rail alignment, copy diet, no rules

Five features, one subagent lane each, sequential (single writer), then one read-only review.
This document freezes scope and ownership; lanes must not edit it.

## F1 — revert the Thinking panel into the agent window

Thinking returns to where it started: the assistant message renders its own collapsible
`<details>` block (summary `Thinking`, body `.thinking-content`) inside `.conversation`.

- Remove the right-rail panel completely: `#thinking-panel` markup, its controller, its
  `FOLLOW` toggle, `THINKING_KEY` / `THINKING_CAP` / the trim note and the
  `pi-desktop:thinking:v1` store, plus the window-settings row that showed/hid it.
- Restore the CSS the panel displaced (`.message details`, `.message summary`,
  `.thinking-content`) and the responsive rules the panel added.
- Drop the lane-C placeholder that pointed thinking-only messages at the panel: with the block
  back, a message with only thinking renders its block and an empty text body, as before.
- Flip every test that asserted *absence* of in-window reasoning (unit, DOM, Chromium,
  native smoke) to assert the block instead, and delete panel-only tests.
- Docs must describe the restored behaviour and stop describing the panel.

## F2 — align the usage widget with the clock widget

The right rail must read as one column: `.usage-widget` matches `.clock-widget` in `right`,
`width` and title/metric rhythm (clock `right: 25px; width: 253px`, narrow layout
`width: 215px`). Usage stays anchored to the bottom (`bottom: 56px`). Bar rows keep their
alignment; only geometry and rhythm change.

Prove it with a DOM test comparing the computed `right`/`width` of both widgets (normal and
narrow viewport) and keep the existing usage assertions passing.

## F3 — copy diet: no defensive or explanatory prose in the UI

Remove sentences that explain behaviour, policy or promises, including the two the operator
quoted:

- `features.js` Appearance paragraph: "The theme colour paints the desktop chrome; the ground
  colour fills the desk. The photo is downscaled, stored locally and turned into the
  point-cloud background: move the pointer to push or pull it, and it springs back when you
  leave. Nothing is uploaded. Very large photos show until the app restarts."
- `features.js` Usage paragraph: "Session totals are authoritative reported stats.
  Active-message usage is provisional and is not added to those totals."
- The motion change note ("tip or move the machine and the cloud leans… Re-zero makes the
  current position level.") and the same class of sentence anywhere else in the UI: the help
  dialog's paragraphs, the usage note, inspection hints, delegated-window notes.

Rule: delete explanation, keep interface. Window titles, field labels, option names, status
words (`UNAVAILABLE`, `WAITING`, `ACTIVE`, `LIVE`, `IDLE`, `OFFLINE`, `provisional` as a tag),
error messages, control affordances (`Show`, `Reset`, `Re-zero`, `Remove`) and the About
widget's brand line stay. Where a control would become meaningless without a hint, keep at
most three words. Sweep with a grep for the same class of wording (`uploaded`, `stored
locally`, `authoritative`, `provisional`, `not added`, `Unknown is not zero`, `never`, `only
while`) and update every UI surface it finds.

Tests and docs that assert the removed sentences must be updated; nothing may assert a
sentence that no longer exists.

## F4 — no horizontal rules inside windows

Remove the horizontal separator lines drawn inside window content: `.message` bottom borders,
`.model-toolbar`, `.empty-kicker`, `.tool-badges span`, `.queue`, `.child-transfer`,
`.agent-error`, and in `features.css` `.feature-toolbar`, `h3`, `.feature-row` (dotted), plus
the delegated-window task/final rules. Fix the padding those borders were propping up so
spacing still reads intentionally.

Keep: window frames and shadows, input and button borders, focus rings, the taskbar and menu
chrome, vertical borders (`.conversation` left/right stays), error and tool boxes that are
genuinely boxes, and widget frames. The rule is "no horizontal separator line inside a
window", not "remove every border".

## F5 — gyroscope research (web, no code)

A researched brief at `docs/gyroscope-research.md`, honest about evidence:

- What can actually read the Apple Silicon accelerometer or gyroscope from a process:
  IOHIDManager / IOHIDEventSystemClient paths, the Sensors page (0x20) usage set, the
  `AppleSPUHIDDevice` vendor page, feature reports, and which ones need private entitlements
  (`com.apple.private.hid.client.event-monitor` and friends) or SIP changes.
- What is available without entitlements: `CoreMotion` on macOS (which classes exist on macOS
  and which do not), `CMHeadphoneMotionManager` with AirPods, using an iPhone or iPad as a
  sensor over the network, and browser `DeviceMotionEvent` on desktop versus mobile.
- Open-source projects and tools that demonstrably do it, with links and what they require.
- What this project already proved (the SPU devices exist, the vendor device opens, zero
  reports reach an unprivileged process, control devices `als`/`cma`/`las` do stream).
- A recommendation matrix: effort, entitlement or permission needed, risk, and whether it is
  worth implementing in Pi Dither, with the honest fallback kept.

## Lanes (sequential, one writer at a time)

| Lane | Feature | May write |
| --- | --- | --- |
| 1 | F1 revert | `desktop/public/app.js`, `index.html`, `styles.css`, `tests/browser-smoke.mjs`, `tests/windows-dom-checks.mjs`, `macos/SmokeChecks.js`, `docs/desktop.md`, `docs/validation.md` |
| 2 | F2 rail alignment | `desktop/public/styles.css`, `tests/windows-dom-checks.mjs`, `tests/browser-smoke.mjs`, `docs/desktop.md` |
| 3 | F3 copy diet | `desktop/public/features.js`, `index.html`, `app.js`, `inspection.js`, `delegated.js`, `tests/*.test.mjs`, `tests/browser-smoke.mjs`, `docs/desktop.md`, `docs/validation.md` |
| 4 | F4 no rules | `desktop/public/styles.css`, `features.css`, `docs/desktop.md`, `docs/validation.md` |
| 5 | F5 research | `docs/gyroscope-research.md` (new) only |
| R | review | nothing (read-only) |

Parent owns: this plan, receipts, the full gate run, acceptance, installation with rollback,
commit and push. Lanes never install, commit or push, never touch `.local/`,
`docs/subagent-test.md`, the installed app or another lane's committed work.

## Acceptance (parent)

145+ Node tests, Chromium fixture, WKWebView 390/1440, four terminal PTY scenarios, release
build without the extension override plus the native smoke, a geometry check for F2, a grep
that finds no removed sentence left in the UI, and a screenshot-free review of the final CSS
to confirm no horizontal separator survives inside a window.

## Context the lanes need

- Delegation runs in-process here: the async runner is broken in this environment (see
  `.local/env-pi-subagents-*.json`), so children are launched blocking and sequenced.
- The laptop accelerometer is withheld from unprivileged processes on this machine; F5 must
  research why and what would change it, and must not claim the sensor works.
