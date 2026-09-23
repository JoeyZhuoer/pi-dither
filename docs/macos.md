# Pi Dither for macOS

## Install and use

The release ZIP contains **Pi Dither.app**, a self-contained Apple Silicon application targeting macOS 14 or later. Drag it to `/Applications` or `~/Applications`, then double-click. A native AppKit window embeds the existing interface in WKWebView. No Terminal, external browser, globally installed Node/Pi, or global extension installation is required to start it.

This release is **ad-hoc signed**, not signed with Developer ID and not notarized. macOS may block downloaded copies; review the source/checksum and use the normal **System Settings → Privacy & Security → Open Anyway** approval if appropriate. Do not disable Gatekeeper globally. The build machine has no Developer ID signing identity. Intel, signing/notarization and App Store distribution are not claimed.

Choose **Windows → Workspace** to select a project; the initial workspace is your home directory. Normal `~/.pi/agent` credentials/configuration remain usable but are not included in the app or changed by installation. A new user can select a provider and enter a server-lifetime API key in **Providers**. OAuth login/custom-provider setup still needs the corresponding upstream Pi setup; packaging does not add terminal-only features. Submitting prompts may incur provider charges; opening the app does not submit a prompt. Git and optional external-agent CLIs are not bundled: Git features require a working Git installation, and external CLI agent profiles need their own installed/authenticated runners.

The native window can be minimized/hidden and restored from the Dock or **View → Show Main Window**. Closing it hides it without killing a task. **⌘Q** requests current status, warns about active/incompletely observed jobs, then requests orderly backend shutdown. Detached pi-subagents jobs retain their upstream lifecycle and may outlive the app, particularly jobs from earlier main sessions; current-session telemetry cannot prove all detached jobs have finished. Finish or stop them before quitting. A service crash presents an error rather than silently launching a second writer or resending prompts.

Copy/paste/select-all, native alert/confirm/text-entry dialogs, Reload Interface and an About panel are provided. The local development build opens newly opened panels at their minimum usable width with a medium height, keeps that width and follows native height changes until you resize them yourself; manual sizes are saved. The app runs your installed native Pi (honouring `HOME`) and the Node runtime that ships with it, exclusively; no Pi, Node or pi-subagents is bundled, and missing Pi/Node fails with a clear message. Installed Pi packages load for the main agent. **Windows → Background** chooses the desk color and an optional photo; the native app shows a standard image-only file picker for it. Separate Auto-size/↗ controls and the native sizing menu command have been removed. Arrange resets compact defaults (which open at the minimum width again); an explicitly requested one-shot reset can clear old window preferences. The background is a plain dusty-pink ground with no pattern or animation. **Laptop motion** is an opt-in Appearance control (**Off**, **Tilt (lean)**, **Full (lean + shake)**): the native host injects `window.__piDitherMotionHost` at document start and delivers accelerometer samples in g plus gyroscope rates in deg/s at up to 60 Hz, so the cloud leans with the gravity direction, lags behind a push and bursts on a knock (a sharp angular jolt also contributes); **Re-zero** makes the current position level. Motion is off by default and, while it is off, the ground is byte-identical to a plain background. The bridge wakes the `AppleSPUHIDDriver` reporting state, opens the accelerometer and gyroscope devices directly with timestamped IOHID callbacks and decodes the 22-byte Q16 int32 report, so the IMU streams unprivileged on this machine; a missing or unreadable sensor still reports **`unavailable`** in words and never fabricates a reading. The main agent loads every package configured in your normal Pi profile, so installed tools and pi-subagents appear automatically. Native Reload forces a full document navigation and privately restores authentication rather than merely navigating back to a stripped token fragment. See the [unreleased feature audit](native-feature-audit.md). Links outside the exact local service origin are blocked; a user-initiated HTTP(S) link offers **Copy Link** instead of opening a browser or navigating the privileged webview. There is no generic JavaScript-to-native filesystem/shell bridge.

## Data and process boundaries

- Native data: `~/Library/Application Support/Pi Dither/` (preferences, kernel-backed SQLite single-instance lease). Pi sessions live in the standard Pi store, `~/.pi/agent/sessions/--<encoded-cwd>--/`, shared with the `pi` CLI.
- A one-shot migration copied the former desktop session stores into `~/.pi/agent/sessions` (with a `preferences.json` archive-key remap and backup); the old directories are left in place as backups.
- Browser layout: WKWebView's standard per-application website data store, at the stable `http://127.0.0.1:4317` origin. Native window geometry uses macOS preferences.
- Existing web-mode `.local` and app-data session stores are not deleted or bundled; their sessions were copied into the global Pi store by the one-shot migration. Ordinary Pi history stays where it was. Saved conversations can be resumed through Sessions after relaunch; startup itself creates a new main conversation.
- Resources inside the app are immutable at runtime. Project operations run in the selected workspace, never the bundle. Replacing the app does not replace user data.
- Swift starts the Node runtime from the native Pi installation directly using `Process`, not a shell. A private stdio handshake transfers the ephemeral authenticated URL in memory; it is never placed in process arguments or logs. The web UI removes the fragment and retains the token in its session storage as before.
- Authenticated loopback, Host/Origin checks, CSP, narrow static allowlist, private Pi bootstrap IPC and approved extension provenance are unchanged. A second native process cannot take the same data-directory SQLite exclusive lease; a hard crash releases that OS lock automatically. Port conflicts fail closed rather than attaching to an unknown service.
- Stdin EOF (including native shell exit/crash) asks the host to close its owned Pi sessions. Normal quit waits for backend exit. It does not indiscriminately kill extension-owned process groups or other Pi conversations. Force-killing the backend itself or whole-machine crashes cannot provide graceful cleanup guarantees.
- The accelerometer and gyroscope are read locally through IOHID in a dedicated background run-loop thread: the bridge wakes `AppleSPUHIDDriver` reporting, opens the devices directly, and decodes 22-byte little-endian int32 Q16 reports (accelerometer in g, gyroscope in deg/s) through timestamped input-report callbacks, delivered to the page at most 60 times a second. A resting-magnitude check (0.5-1.6 g) gates `available`, so a missing or misdecoded sensor can only end in `unavailable`, never a fabricated reading. After every navigation the live status is written back into the page, because the injected script re-runs with its launch-time value on Reload. No sample, rate or device name leaves the machine, and no entitlement, daemon or helper process is added.
- **Known gap, documented rather than guessed:** there is no Sensors-page (0x20) accelerometer fallback. The 0xFF00 vendor device matches and opens on this hardware, and a page-wide 0x20 match would also attach to non-motion sensors (the light sensor is `0x20/0x8a`), so a fallback needs per-usage knowledge that could not be verified on this machine.
- Main tools and delegated writers are **not an OS sandbox**. The manual child read-only ceiling is unchanged. Only the bundled approved pi-subagents package is explicitly loaded into main; unrelated installed extensions are not packaged.

## Reset window layout only

The local follow-up supports `--reset-window-layout`. First quit normally (finish active work first), then explicitly launch:

```sh
open "$HOME/Applications/Pi Dither.app" --args --reset-window-layout
```

This clears only the native `PiDitherMain` saved frame, `pi-desktop:layout:v1` and session-storage observer-dismissal keys prefixed `pi-desktop:delegated-closed:v1:`. The page reset runs before UI initialization at the exact private local origin; its script is removed after that first load, so Reload and later ordinary launches preserve newly chosen geometry. It never clears the whole website store or changes conversations, credentials, workspace preferences, the chosen ground colour or the background photo. Normal app relaunch still starts a fresh main session; saved conversations remain available in Sessions.

## Build

Prerequisites: macOS/Apple Silicon, Xcode Command Line Tools, Node 22 or newer to build. The built app requires your installed **core Pi** (including its Node runtime) at launch; **pi-subagents** is loaded from the Pi profile at runtime. Neither is bundled. Build offline; nothing is installed into the user's Pi profile.

```sh
npm run app:build
npm run test:macos
npm run app
```

To validate a development build without overwriting existing `dist/` artifacts, set `PI_DITHER_BUILD_DIR` to a dedicated output directory, then pass its app path through `PI_DITHER_TEST_APP` to `npm run test:macos`. The test refuses to start while another Pi Dither executable is running; it never stops that instance for you. Builds include `source-inventory.json` hashes of allowlisted app files and native/build inputs, checked against source by the native tests.

`PI_WORKSTATION_PI_ROOT` overrides Pi discovery for the development launcher and web server. The app uses the installed Pi version as-is (no version whitelist) and fails with a clear message when Pi or Node is missing; the build does not pin or bundle Pi, Node or subagents. `desktop/public/motion.js` is part of the packaged allowlist.

Outputs in ignored `dist/`:

- `Pi Dither.app`
- `Pi-Dither-0.5.0-macOS-arm64.zip`
- `SHA256SUMS.txt`

The packager copies only allowlisted application source. It does not bundle Node, Pi, pi-subagents, the entire checkout, user profiles or credentials; Node, Pi and all packages are loaded from the user's native installation and profile at runtime. `Contents/Resources/runtime-inventory.json` records the application/platform and `THIRD-PARTY-NOTICES.txt` points to notices. Native binaries and the outer app are ad-hoc signed, verified and archived. Source remains plain JavaScript plus Swift; no Electron, React, frontend bundler or network-hosted assets.

## Validation and limitations

`npm run test:macos` copies the signed bundle to a path with spaces outside the checkout, uses an empty temporary Pi profile, strips the global runtime from PATH, opens the actual AppKit/WKWebView window through direct-executable and Finder/LaunchServices routes, checks connected empty main/bundled extension tools/no startup children/token removal, exercises all eight utility windows, native resizing/auto-size/manual preservation/maximize, draft create-close, dropdowns, the plain background, the laptop-motion bridge (the injected host object and its contract, an honest sensor status, and a synthetic sample stream that leans the drawn cloud, follows the tilt direction, bursts on a knock and returns home once motion is off), hide/reopen and Reload, then quits, and checks for surviving owned processes. The direct fixture also seeds stale layouts and unrelated preferences, verifies the selective one-shot reset, and proves Reload preserves subsequent manual geometry. It sends **no provider prompts**. Unit tests cover lease exclusivity/release, authenticated service startup and quit-state classification. Chromium/real-DOM/terminal checks remain separately available.

Physical tilt and shake verification needs a machine whose system actually streams the SPU accelerometer; on this machine it is withheld, so the bridge is validated through its honest `unavailable` status, the device/decode probes recorded in the native feature audit, and the synthetic end-to-end path. macOS 14 is the compilation/deployment floor, not a claim that every older macOS version has been manually tested. Full paid-provider streaming, real child billing/completion, Intel, exhaustive WebKit interactions/accessibility, distribution Gatekeeper approval and notarization remain outside this validation.
