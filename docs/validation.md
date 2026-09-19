# Pi Dither validation

Target: Pi Dither 0.4.0, core Pi 0.85.1, pi-subagents 0.69.0, Node.js 22.23.2, Apple Silicon/macOS. This is not certification of every Pi feature, platform or terminal.

## v0.4 acceptance

- **106/106** Node/real-DOM checks passed, with `PI_DESKTOP_FEATURE_BROWSER_TEST=1` and Edge Chromium; no skips. Includes existing controls/session/tool/delegation/layout regressions and native auth/lease/quit-state/symlink-entry/EOF process-cleanup checks.
- Integrated Chromium fixture browser passed: authentication, safe rendering, controls/tools, live observer fixtures, independent window positions/slots, reload/mobile layout, motion and reduced-motion behavior.
- Relocated signed `.app` passed real **AppKit/WKWebView** launches through direct execution and Finder/LaunchServices with an isolated empty Pi profile and no global Node/Pi on PATH. Confirmed connected sole main, no messages, loaded bundled extension and delegation tools, token-fragment removal, orderly service exit and no surviving owned processes. Application archive excludes user profiles and unrelated extensions.
- Deep/strict ad-hoc code-signature verification passed; ZIP/checksum generated. Developer ID signing/notarization and Intel support are not claimed.
- All four real-Pi terminal PTY scenarios passed. No provider-backed prompts were sent by these checks.

Private local logs remain ignored under `.local/macos-{build,smoke,node-tests,browser-tests,terminal-tests}.log`. Runtime/build instructions: [macOS](macos.md). Historical desktop milestones: the implementation-plan documents.

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
