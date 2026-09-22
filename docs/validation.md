# Pi Dither validation

Target: Pi Dither 0.4.0, core Pi 0.85.1, pi-subagents 0.69.0, Node.js 22.23.2, Apple Silicon/macOS. This is not certification of every Pi feature, platform or terminal.

## Plain background and installed packages (unreleased release artifact; source on `main`)

The animated background pattern is removed: the old backdrop module, canvas, motion preference and pause control are gone, and aggregated fleet activity is still computed and exposed as `#desktop[data-activity]` for the Activity window. In its place the appearance is user-controlled from the **Appearance** window: a theme (chrome) colour, a ground colour and an image picker, each with its own default. The photo is downscaled, stored locally and painted as an ordered dither between the ground colour and the standard dark ink. A pointer stir behaves like the reference field: dots within 10px swirl and spread while constellation lines fan out to distinct dots within 40px, then everything fades back to the exact base pattern. An optional particle field (off/sparse/normal/dense) drifts dots that link within 90px, bounce off the edges, collide elastically with a short square flash and are stirred by the pointer inside 80px; unit tests cover deterministic field creation, bounded speeds and edge bounces, elastic momentum exchange with flash ageing, pointer reach and the link/draw rules, while the Chromium and native fixtures enable it, verify ink on the layer, a pointer stir and a clean switch-off. The top-right **⚙** window chooser lists every window, remembers which ones keep a bottom-bar button (less frequent windows start out) and opens any window directly; every window remains in the Windows menu. Unit tests cover colour normalization, one-cell-per-CSS-pixel sizing with the large-window bound, deterministic ordered dithering by luminance, exact ground/ink pixels in the single ImageData paint and storage guards; the Chromium fixture and the native WKWebView smoke change both colours, feed a synthetic photo through the real file input, verify ink appears on the canvas, verify removal and both resets clear/restore storage, tick windows in the settings dialog (bottom-bar button appears/disappears, direct open works), and dispatch a pointer move to verify the dots spread and settle back to the exact base hash. No upload, network request or animated backdrop is involved, and the one-shot window-layout reset leaves colour and photo untouched.

The main agent now loads packages the same way normal Pi does: global profile `packages` (for example pi-web-search, pi-atelier and pi-subagents) are discovered through the resource loader, so their tools, commands and skills are available; the bundled pi-subagents copy is added only when the profile does not configure its own, so it never loads twice. Project `.pi` resources remain untrusted, subagent windows stay on their built-in read-only tools with no extensions, `PI_OFFLINE=1` means missing packages are never installed, and the desktop never edits Pi settings. A broken package is reported in the Tools status instead of failing startup. Verified with extension unit tests (profile-provided vs bundled fallback, escaping entries rejected, project untrusted), the installed-Pi RPC regression (a throwing profile extension is discovered and reported, the project copy is not), and a real-profile run that loaded `web_search`, `url_context` and the pi-subagents tools plus package commands. No provider prompt or paid call was used. See [feature audit](native-feature-audit.md).

## Opening geometry: minimum width, medium height (unreleased release artifact; source on `main`)

Every window opens at its roomy default width (main 610, manual child 270, delegated/utility 400) with a medium height (`round(desktop height × 0.6)`, never below the kind minimum), and can be resized down to its floor (main 360×320, child 270×250, delegated/utility 400×320). Unit and real-DOM checks place main at 380×340 and at its 360×320 floor, confirm keyboard resize stops there, keep the main-relative child cap, and confirm Arrange returns it to the roomy 610-wide opening size. Auto-sized windows keep that width and follow native/container height changes; compact purpose presets remain the Arrange/anchor geometry. Manual resizes replace the opening size and are saved across hide/show, Reload and relaunch. Unit and real-DOM tests assert exact opening geometry at 1200×760 and 1400×900, viewport height recovery, compact-preset distinctness, strict manual preservation, maximize/restore and Arrange; the native smoke asserts the 610px main, uniform 400px utilities and height recovery at 800/980/1440px. No provider prompt was used. The same wave cleared the user's saved window layout through the one-shot `--reset-window-layout` path after installation.

## Automatic-on-open follow-up (unreleased)

**133/133** Node/real-DOM tests, integrated Chromium, isolated WKWebView at 390/1440px, four terminal PTY scenarios and rebuilt relocated direct/Finder native launches passed again. No fitting button is required: new main/child/observer windows fit on creation; utilities fit on opening with distinct purpose profiles. Coverage includes draft-to-child manual geometry transfer, responsive recovery, hidden/focus preservation and removal of all dedicated sizing controls.

The direct native fixture seeds stale manual geometry/visibility and observer dismissal alongside unrelated local/session-storage preferences. `--reset-window-layout` selectively clears the former, retains the latter, and removes its injection before Reload. Subsequent manual geometry, session, tools and empty messages survive Reload. Tests use isolated data/profiles; no paid prompts. Build/evidence: `.local/purpose-fit-build/`, `.local/purpose-fit-*-tests.log`; [feature audit](native-feature-audit.md). After these gates, the verified archive was installed with a rollback copy and opened with the requested one-shot layout reset; success was confirmed. No conversations, credentials or workspace preferences were cleared. Receipt: `.local/purpose-fit-install-20260920T235638Z.json`. The follow-up source is published on `main`; no new release artifact was published.

## Earlier native auto-size and feature audit (unreleased)

**134/134** Node/real-DOM tests, integrated Chromium, isolated WKWebView at 390/1440px and all four terminal PTY scenarios passed. A fresh ad-hoc signed app passed source/bundle parity checks and relocated direct/Finder launches, covering all eight utilities, actual native window resizing, automatic/manual sizing, maximize, draft controls, dropdowns, motion, hide/reopen and full Reload without changing the main session/messages/tools. The expanded Reload test initially timed out; forced full navigation with a nonsecret nonce fixed the same-document fragment-navigation weakness, and both native launch routes then passed, including deliberately lost cached auth.

See [native feature audit](native-feature-audit.md) for the complete feature matrix, evidence paths and residual gaps. Build: `.local/native-autosize-build/Pi Dither.app`. Validation left the installed application, existing conversations and published v0.4 artifacts untouched. After explicit approval, the verified archive was installed locally with a rollback copy and signature/source verification; the app was not launched and its data was not accessed. No paid prompts or publication occurred.

## v0.4 acceptance

- **106/106** Node/real-DOM checks passed, with `PI_DESKTOP_FEATURE_BROWSER_TEST=1` and Edge Chromium; no skips. Includes existing controls/session/tool/delegation/layout regressions and native auth/lease/quit-state/symlink-entry/EOF process-cleanup checks.
- Integrated Chromium fixture browser passed: authentication, safe rendering, controls/tools, live observer fixtures, independent window positions/slots, reload/mobile layout, motion and reduced-motion behavior.
- Relocated signed `.app` passed real **AppKit/WKWebView** launches through direct execution and Finder/LaunchServices with an isolated empty Pi profile and no global Node/Pi on PATH. Confirmed connected sole main, no messages, loaded bundled extension and delegation tools, token-fragment removal, orderly service exit and no surviving owned processes. Application archive excludes user profiles and unrelated extensions.
- Deep/strict ad-hoc code-signature verification passed; ZIP/checksum generated. Developer ID signing/notarization and Intel support are not claimed.
- All four real-Pi terminal PTY scenarios passed. No provider-backed prompts were sent by these checks.

Private local logs remain ignored under `.local/macos-{build,smoke,node-tests,browser-tests,terminal-tests}.log`. Runtime/build instructions: [macOS](macos.md). Historical desktop milestones: the implementation-plan documents.

## Local inspection/combobox acceptance (unreleased)

- **129/129** Node/real-DOM tests passed with both `PI_DESKTOP_FEATURE_BROWSER_TEST=1` and `PI_COMBOBOX_BROWSER_TEST=1`, using Edge; zero skips/cancellations. Includes provisional-to-terminal regressions, prompt-redaction sentinel handling, bounded/redacted DTOs, exact tool/file attribution, clone/hydration suppression, session reset, inspector lifecycle, dynamic dropdown reconstruction and real-DOM component checks.
- Integrated Chromium fixture passed manual/delegated inspection updates with unchanged output/revision, disconnected and old-backend fallback, stable expansion/focus/geometry and a reachable 325×310 manual inspector, safe text, native-change keyboard commits and themed popup styling/clamping, alongside existing desktop regressions.
- `npm run test:webkit` passed both **390px and 1440px** standalone AppKit/WKWebView component fixtures. Compiles a temporary host, uses an ephemeral loopback port, nonpersistent web storage and credential-free temporary HOME; never launches the installed app or a Pi/provider process. Covers dropdown keyboard/cancel/typeahead, pointer handlers, safe labels, native form values/fallback, inherited disabled state, viewport bounds, dynamic repair, focus/teardown, plus inspection metrics/scope/redaction and expansion/scroll/output bounds.
- All four real-Pi terminal PTY scenarios passed unchanged.
- Parent corrected the review findings: retained live usage is not silently finalized; reconstructed selects regain their accessible trigger; upstream-redacted prompts are unavailable. Existing transcript code/edit arguments remain visible with credential masking. A real-DOM fixture's missing module route was added, and a fixed-delay bridge assertion now waits for bounded evidence rather than assuming two polling cycles fit in 35 ms.

The installed app remained running on port 4317. No existing conversations were operated on, and no commit, push, release, installation or restart was performed. New browser/backend assets are explicitly static/bundle-allowlisted, but a new distributable and Finder/LaunchServices bundle launch were **not** built/revalidated in this wave.

These are synthetic telemetry/component checks and public no-prompt runtime probes—not proof of live paid child completion/billing, all upstream prompt availability, physical touch/VoiceOver behavior, or exhaustive WebKit/accessibility coverage. Async APIs still omit some child metrics; missing data is explicitly unavailable.

Private logs: `.local/inspection-{node,browser,webkit,terminal}-tests.log`; screenshots remain ignored. Plan and review dispositions: [agent inspection plan](agent-inspection-plan.md).

## Preserved terminal checks

- Eight terminal unit/render checks, included in `npm test`, covering all 56 theme tokens, both color modes, real Pi cell-width measurements, Unicode/ANSI metadata, compact/roomy rendering, ASCII fallback, UI lifecycle cleanup, current-theme rendering, model changes, and no TUI work in RPC/JSON/print modes.
- `npm run test:terminal`: 4 real-Pi PTY scenarios: regular 80×24/256-color, regular 120×40/truecolor, fullscreen 80×24/256-color, fullscreen 120×40/truecolor.
- Each PTY scenario covers startup, layout off/on, compact/auto, harmless `!!printf` execution, `/reload`, `/new`, shrinking to 40 columns and restoring size, `/quit`, and the bracketed-paste restoration sequence.
- JavaScript/shell syntax checks and `git diff --check`.

PTY tests use temporary HOME/config/session directories and an explicit environment without provider credentials. Startup networking is disabled; no LLM prompts are submitted. This is not a network sandbox. Fullscreen tests account for differential rendering and a scrollable startup header rather than assuming it is pinned.

## Terminal preservation boundary

Production code imports only public Pi APIs. It registers one local UI command and notification-only session/model hooks. It does not register tools, override the editor/footer, transform prompts/messages, touch credentials/settings/session files, intercept raw input, replace trust decisions, or run shell commands. Only the test harness executes a harmless shell fixture.

The local launcher disables ambient extensions to keep this release core-only. It retains normal core trust flow and persistence unless the user passes an explicit core flag. No global Pi installation or settings change is required.

## Not yet certified

- Live provider streaming, billing, retries, compaction, or steering/follow-up cancellation under a live model.
- Clipboard images, IME, external editors, assistive technology, or every configured keybinding.
- Exhaustive session import/export/fork/tree and trust-cross-cwd regressions.
- Every terminal emulator, platform, or third-party extension.
- Behavior after an upgrade beyond Pi 0.85.1. Fullscreen remains Pi's experimental mode.

These behaviors remain core-owned, but keeping ownership unchanged is not a substitute for testing them.
