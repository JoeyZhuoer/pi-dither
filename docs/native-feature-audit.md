# Native window sizing and feature audit

Status: **validated, installed and opened; follow-up source published on `main` while the public v0.4 release artifact is unchanged**. Core Pi 0.85.1, pi-subagents 0.69.0 and terminal behavior remain unchanged. The earlier local inspection/dropdown changes are included in this build.

## Findings and fixes

1. **Sizing was packaged, but its state was ambiguous.** Before this fix, installed and source `windows.js` had identical SHA-256 digests. A single `zoomed` flag represented both a prior automatic fit and a deliberate manual adjustment. Reproducing a narrow-to-wide desktop transition showed why an auto-fitted window could remain pinned to its smaller size.
   - Persist separate **compact / auto / manual** sizing intent.
   - Auto-sized windows follow their purpose-specific working dimensions as the native window or desktop container changes size. A `ResizeObserver` covers container changes without relying solely on browser resize events.
   - Manual geometry and mobile desktop preferences remain intact. Resizing does not focus/reveal hidden windows; streaming does not trigger auto-fitting.
   - New visible main/child/observer windows open immediately, not only after title-bar selection. Utilities open when shown. Separate Auto-size/↗ controls and the native sizing menu command have been removed at the user's request. Children retain their right-side anchors and fit the available height below them.
   - Opening geometry is the **minimum usable width** (main 610, manual child 270, delegated/utility 400) with a **medium height** (`round(desktop height × 0.6)`, never below the kind minimum). Auto-sized windows keep that width and follow native/container height changes; any manual resize replaces both and is saved. Compact purpose presets remain the Arrange/anchor geometry.
   - Old `zoomed=true` layouts remain protected because their origin cannot be inferred. Arrange resets sizing intent to compact defaults, which open at the minimum width on selection/opening. An explicitly requested native `--reset-window-layout` clears only saved panel geometry/visibility, observer dismissals and the native frame. It is one-shot; Reload preserves subsequent manual geometry and unrelated preferences.
   - Maximize/restore preserves automatic intent, including reload. A launched manual child inherits its draft's sizing intent.
2. **The expanded native Reload check exposed a navigation weakness.** Reloading the original bootstrap URL after the UI removed its fragment could become a same-document fragment navigation instead of a full page reload. The first extended native test timed out at this area.
   - Native Reload now uses a fresh, nonsecret query nonce to force document navigation while retaining fragment-only bootstrap authentication. The UI immediately removes both nonce and fragment. Tokens never enter the query string.
   - The regression deliberately removes the cached session-storage token, then verifies successful reload, clean URL, unchanged session/messages/tools, retained layout and no startup child drafts. No session is recreated and no prompt is resent.
3. **Bundle/source parity is now checked.** Builds include SHA-256 inventories for allowlisted app files and native/build inputs. Native tests compare the relocated app with current source, including the new inspection/dropdown modules. Smoke checks are a separate, explicitly copied validation resource; they are not served by the desktop HTTP API and run only in isolated smoke mode.

## Feature coverage

| Area | Checked evidence | Result / boundary |
| --- | --- | --- |
| Automatic-on-open fitting, minimum width + medium height | Unit tests; real DOM; native 800/980/1440px width transitions | Pass; no fitting button, compact presets separate, manual sizes saved |
| Selective one-shot layout reset | Native fixture seeded with stale geometry/visibility and unrelated local/session preferences | Pass; geometry/dismissals cleared, other preferences retained, script removed before Reload |
| Background colour and dithered photo | Unit tests (colour validation, bounded bitmap, ordered-dither luminance behaviour, ground-then-ink painting, storage guards); Chromium and native WKWebView fixtures (colour applies, synthetic photo dithers to ink, remove/default restore, persistence); no animated backdrop or motion control | Pass; photos stay in the local website store and are never uploaded; live file-dialog interaction not automated |
| Installed packages for main | Extension unit tests (fallback vs profile-provided discovery, no double load, escaping entries rejected), installed-Pi RPC regression (profile extension discovered, project extension untrusted, load errors reported not fatal), real-profile verification of web search + pi-subagents tools | Pass; nothing installed automatically, Pi settings unchanged |
| Drag/keyboard resize, maximize/restore, Arrange | Unit/Chromium; native maximize and keyboard resize | Pass; custom geometry retained |
| Hide/minimize/taskbar/reload, mobile layouts | Chromium, WKWebView, actual app hide/reopen and Reload handlers | Pass; no implicit agent launch or focus/reopen on resize |
| Models and thinking | Form/API contract and guard tests; native utility loading | Pass; no paid inference |
| Providers and temporary keys | Isolated runtime/control races, secret masking, real-DOM forms; native empty key control | Pass; real key validity/OAuth not tested |
| Workspace, bookmarks, Git and worktrees | Temporary filesystem/Git tests, real-DOM contracts, native read-only loading | Pass; user's workspace/data not modified |
| Sessions: new/resume/clone/rename/archive | Temporary stores and synthetic transcripts, stale/context guards; native listing | Pass; existing conversations not operated on |
| Tools and manual read-only ceilings | Installed-SDK tests, none/subset/all, busy/stale guards; native catalog | Pass; no authority expansion |
| Manual children and unsent handoff | Synthetic integrated browser; native draft create/close without Launch | Pass; no provider-backed child execution |
| Delegated observers and inspection | Identity/projection/attribution/redaction tests, integrated browser, WK components | Pass; upstream-redacted prompts/missing async usage remain unavailable |
| Usage chart and scoped costs | Unit/DOM tests, native widget | Pass; real billing not certified |
| Safe Markdown, tool output, dropdown menus | Node/real DOM, Chromium/WK, native dropdown | Pass; unknown telemetry not fabricated |
| Clock, motion, pause/reduced motion | Unit/Chromium and native clock/pause checks | Pass; reduced-motion preference respected |
| Auth, origin/CSP, stale commands, ownership | Server/native-host tests; native private bootstrap/reload | Pass; no generic native filesystem/shell bridge |
| Native packaging and lifecycle | Source hashes, deep/strict ad-hoc signature, relocated direct + Finder launches, EOF/shutdown cleanup | Pass; Apple Silicon only, no notarization claim |
| Original terminal interface | Full unit suite and four real-Pi PTY scenarios | Pass; regular/fullscreen, small/large, both color modes |

## Acceptance evidence

- **133/133** Node/real-DOM tests; zero failures, skips or cancellations.
- Integrated Chromium desktop fixture passed, including actual viewport resize recovery, manual/delegated inspection and retro dropdowns.
- Isolated WKWebView checks passed at **390px and 1440px**, covering component behavior, all eight utility sizing profiles, container resize recovery and layout preservation.
- Rebuilt, relocated **Pi Dither.app** passed direct-executable and Finder/LaunchServices launches. Native stages exercised minimum/narrow/wide sizes, automatic recovery, manual override, maximize, all eight utilities, explicit draft controls, menus, the plain background, hide/reopen and full Reload. The same idle main session, empty messages and tool selection remained intact. No owned app/Pi processes survived shutdown.
- Four terminal PTY scenarios passed. Syntax/whitespace and package integrity checks passed.

Earlier sizing-wave evidence (historical): `.local/autosize-{node,browser,webkit,terminal,macos}-tests.log` (build log is `.local/autosize-macos-build.log`). The validated build is `.local/native-autosize-build/Pi Dither.app`. After explicit approval it was installed at `~/Applications/Pi Dither.app` from the verified archive, with the previous app preserved in a hidden `.Pi-Dither-rollback-*` directory beside it. Installation verified signatures/source hashes and did not launch the app or access its data/conversations. Receipt: `.local/native-autosize-install-20260920T075501Z.json`. Previous `dist/` release artifacts remain untouched. Later follow-up source (inspection, automatic sizing, selective reset, the plain background and installed-package loading) is published on `main`; no new release archive was published.

Latest automatic-on-open wave: `.local/purpose-fit-{node,browser,webkit,terminal,macos}-tests.log`, `.local/purpose-fit-macos-build.log`, build `.local/purpose-fit-build/Pi Dither.app`. All gates above passed again, including seeded one-shot reset and manual draft → launched-child geometry transfer. The previously running app was quit through its normal guarded Quit path for native validation; no forced stop or provider prompt was used. The accepted archive was installed with an independently verified rollback copy, then opened with `--reset-window-layout`; the native app confirmed success. Receipt: `.local/purpose-fit-install-20260920T235638Z.json`; acceptance: `.local/purpose-fit-acceptance.json`. Only window preferences were reset. Conversations, credentials and workspace preferences were not cleared; normal app startup created a fresh main session, with saved conversations still available through Sessions.

This is a feature-area regression audit, **not exhaustive certification**. Live provider streaming/billing/cancellation, real external-agent runners, OAuth, physical-touch/VoiceOver/IME interactions, every native alert path, Intel and Developer ID/notarization remain outside these checks.

## Repeat safely

```sh
CHROME_PATH='/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' \
  PI_DESKTOP_FEATURE_BROWSER_TEST=1 PI_COMBOBOX_BROWSER_TEST=1 npm test
CHROME_PATH='/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' npm run test:browser
npm run test:webkit
npm run test:terminal
PI_DITHER_BUILD_DIR="$PWD/.local/purpose-fit-build" npm run app:build
PI_DITHER_TEST_APP="$PWD/.local/purpose-fit-build/Pi Dither.app" npm run test:macos
```

Leave `PI_DESKTOP_TEST_URL` unset for the synthetic browser fixture. Native bundle validation refuses to start if an existing Pi Dither executable is running, preventing LaunchServices from redirecting tests into a user's app. The smoke profile, data, port and website storage are isolated. Testing a build does not install it.
