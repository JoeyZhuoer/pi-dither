> Superseded by docs/ui-next-wave-plan.md: the Thinking panel described below was reverted into the agent window in the following wave.

# Next wave plan — 2px dots, laptop-motion physics, streaming Thinking panel

Three features, three writer lanes, one writer at a time, parent integrates and publishes.
This document freezes the interfaces the lanes implement against; lanes must not edit it.

## Features

**F1 — 2px dots.** `PHOTO_SIZE` 1 → 2. The point count stays 800,000 (`PHOTO_POINTS`). The
sampling, dither, decimation, force model and idle park are unchanged. Cost is expected to
roughly triple the draw phase (each dot writes 4 pixels instead of 1); the lane must measure it
and report the number instead of guessing.

**F2 — laptop-motion physics.** When the machine is moved, the cloud reacts physically:

- **lean** — a change in the gravity direction sways the whole cloud (a bubble level),
- **lag** — horizontal acceleration makes the cloud swing behind the movement and spring back,
- **shake** — a sharp impulse bursts the cloud outward from the centre.

Off by default (`pi-desktop:motion:v1`), enabled from the **Appearance** window, with a status
line that says whether a sensor was found, and a **Re-zero** control that captures the current
resting orientation as neutral. With motion off the background must behave *byte-identically* to
today; a regression test must prove that.

**F3 — streaming Thinking panel.** Thinking leaves the agent window and streams in a new panel on
the right rail. The agent conversation no longer renders a thinking block at all.

## Contracts (frozen)

### C1 — native motion host → web (`window.__piDitherMotionHost`)

Injected at document start by the native host in `macos/PiDither.swift`:

```js
window.__piDitherMotionHost = {
  version: 1,
  status: 'available' | 'unavailable' | 'denied',
  latest: null,                 // last { x, y, z, at } in g units, device axes
  peak: 0,                      // max |Δa| since the previous delivery, g
  subscribe(callback),          // callback({ x, y, z, at, peak }); returns unsubscribe
  deliver(sample),              // host calls this at <= 60 Hz
}
```

The host must never assume the page defined anything: it injects the object itself, keeps
`latest`/`peak`/`status` current even with no subscriber, and calls `deliver` at ≤ 60 Hz.
If the sensor cannot be opened the object still exists with `status: 'unavailable'` (or
`'denied'` when IOHID access is refused) and the app must keep working normally.

Sensor on this machine (verified with `ioreg`): `AppleSPUHIDDevice`, `Product "accel"`,
`PrimaryUsagePage 65280` (0xFF00), `PrimaryUsage 3`, `ReportInterval 8000` µs (125 Hz),
22-byte input reports with no report ID, `ReportDescriptor 06 00ff 0a 03 00 a1 01 15 00 26 ff00
75 08 95 16 81 02 c0`. Decode the 3 little-endian Float32 in the report prefix as x, y, z in g;
the lane must verify at rest that `sqrt(x²+y²+z²)` is ≈ 1 g (0.5–1.6) and that samples arrive at
≥ 10 Hz, and must fall back to `status: 'unavailable'` if neither the vendor page nor a standard
Sensors-page accelerometer (page 0x20) can be opened.

### C2 — `desktop/public/motion.js` (new, pure and testable)

```js
export const MOTION_KEY = 'pi-desktop:motion:v1';
export const MOTION_MODES = { off: 0, tilt: 1, full: 2 };
export const MOTION_SWING = 120;        // px of cloud lean per g of tilt change
export const MOTION_SWING_STIFFNESS = 26, MOTION_SWING_DAMPING = 7;   // spring for lean + lag
export const MOTION_LAG = 9;            // px per g of horizontal acceleration
export const MOTION_SHAKE = 34;         // px of radial burst at full shake
export const MOTION_SHAKE_THRESHOLD = .18, MOTION_SHAKE_DECAY = 2.4;  // g, per second
export function motionMode(value) { /* 'off' | 'tilt' | 'full', anything else -> 'off' */ }
export function readMotion(storage) / writeMotion(storage, value)
export function gravityDirection(sample, previous, alpha = .12)      // low-passed unit vector
export function motionInput(sample, state, { seconds })               // { tiltX, tiltY, lagX, lagY, shake }
export function stepSway(state, input, { seconds })                   // critically damped spring
export function createMotion({ provider, storage, document, onSample } = {})
//   -> { mode, status, sway: {x, y}, shake, setMode(value), rezero(), sample(input), destroy() }
```

Provider discovery order: `window.__piDitherMotionHost` → `DeviceMotionEvent` (web fallback,
`accelerationIncludingGravity` in m/s² converted to g) → none (`status: 'none'`). `sample()`
accepts an injected sample so tests and the native host can drive it without any sensor.

### C3 — physics hook in `desktop/public/particles.js`

```js
stepPhotoCloud(pool, cloud, { pointer, centerX, centerY, strength, sway, shake } = {})
```

- `sway = { x, y }` in canvas pixels is added to every point's target: the whole cloud leans and
  swings. `undefined` means no motion (identical to today's maths, bit for bit).
- `shake` (0..1) adds a radial impulse from the canvas centre that decays with the shake level.
- `drawPhotoCloud` is unchanged (still no pointer tilt; `CLOUD_PARALLAX` stays 0).
- The controller feeds `sway`/`shake` from `motion.js` on every physics step and keeps the loop
  awake while either is non-zero, then parks again.

### C4 — Thinking panel

- The protocol state already carries `messages[].thinking` and streams state over
  `GET /api/events`; no protocol shape change is expected. If a lane finds a real gap (for
  example an activity/ended flag), the smallest additive change is allowed.
- `desktop/public/index.html` gains `<aside id="thinking-panel" class="thinking-widget">` on the
  right rail (between the clock widget and the usage widget) with a retro title bar
  (`Thinking <span>LIVE|IDLE|OFFLINE</span>`), the subject line (agent name, kind, model), the
  stream body (`#thinking-stream`, monospace, pre-wrap, scrollable) and a `FOLLOW` toggle.
- The panel follows the **selected agent** (the one the bottom bar marks `selected`) and
  auto-scrolls while `FOLLOW` is on and the reader has not scrolled up.
- Empty states: no agent selected / no thinking yet / the model does not expose thinking
  (`model.reasoning === false`).
- `pi-desktop:thinking:v1` stores `{ visible, follow }`, default `{ visible: true, follow: true }`.
  The **⚙ window settings** dialog gains a "Thinking panel" row that shows/hides it.
- The agent window must no longer render a thinking `<details>` block; the conversation, message
  order and markdown rendering are otherwise untouched.
- Responsive: the panel collapses gracefully on the narrow/mobile layout instead of overlapping
  the conversation.

## Lanes

Sequential — one writer at a time, in this order, because the lanes share `app.js`,
`index.html`, `browser-smoke.mjs` and the docs. Every lane starts from the *previous lane's*
working tree: never revert or reformat another lane's changes.

| Lane | Owner | Deliverable | Files it may write |
| --- | --- | --- | --- |
| A | writer | F1 + F2 web side (2px, `motion.js`, physics hook, Appearance control, tests, docs) | `desktop/public/particles.js`, `desktop/public/motion.js` (new), `desktop/public/app.js`, `desktop/public/index.html`, `desktop/public/*.css`, `desktop/server.mjs`, `tests/particles.test.mjs`, `tests/motion.test.mjs` (new), `tests/browser-smoke.mjs`, `package.json`, `docs/desktop.md`, `docs/validation.md` |
| B | writer | F2 native side (IOHID accelerometer bridge, native checks, docs) | `macos/PiDither.swift`, `macos/SmokeChecks.js`, `docs/macos.md`, `docs/native-feature-audit.md`, `scripts/build-macos.mjs` and `tests/macos-smoke.mjs` only if genuinely required |
| C | writer | F3 Thinking panel (right rail, streaming, ⚙ toggle, tests, docs) | `desktop/public/index.html`, `desktop/public/app.js`, `desktop/public/*.css`, `desktop/protocol.mjs` (only if a real gap), `tests/*.test.mjs`, `tests/browser-smoke.mjs`, `docs/desktop.md`, `docs/validation.md` |
| R | reviewer | fresh-context read-only review of the three lanes against this plan | none (read-only) |

Parent (this session) owns: this plan, receipts under `.local/`, the full gate run, acceptance,
installation with rollback, commit and push.

Nothing outside a lane's file list may be touched: no `.local/`, no app bundle, no
`docs/subagent-test.md`, no provider credentials, no commits, no pushes.

## Acceptance (parent, after all lanes)

1. `npm test` — all Node/real-DOM tests, no skips.
2. `npm run test:browser` — Chromium fixture.
3. `npm run test:webkit` — isolated WKWebView 390/1440.
4. `npm run test:terminal` — four terminal PTY scenarios.
5. Native: quit the installed app, `PI_DITHER_BUILD_DIR=$PWD/.local/<wave>-build npm run app:build`,
   then `PI_DITHER_TEST_APP=… npm run test:macos` (direct launch + relocated/Finder launch),
   including the new motion assertions and the full Reload check.
6. Benchmark: `node .local/measure-particles.mjs` for the 2px draw cost.
7. Manual sanity on the installed app: dots visibly 2px; motion off = no movement; motion on =
   lean when the laptop tilts, burst on a shake; re-zero works; thinking streams on the right and
   the agent window shows none.

## Risks and unknowns

- **Accelerometer decode** is reverse-engineered: if the report layout is not 3 LE Float32 the
  lane must say so and degrade to `status: 'unavailable'` rather than guessing silently.
- **2px × 800k** may exceed the frame budget; the lane reports the measured cost, and the parent
  decides whether to keep both values as asked or to surface the trade-off to the user.
- **Motion is global by design** (a laptop-move effect), so the earlier "far dots must not move
  with the mouse" rule still holds for the pointer: motion must stay off by default and must not
  be driven by pointer movement.
- **Thinking volume**: streaming text can be long; the panel must stay bounded (max height,
  scroll, trimmed DOM) so it cannot slow the desktop.
