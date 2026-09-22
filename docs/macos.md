# Pi Dither for macOS

## Install and use

The release ZIP contains **Pi Dither.app**, a self-contained Apple Silicon application targeting macOS 14 or later. Drag it to `/Applications` or `~/Applications`, then double-click. A native AppKit window embeds the existing interface in WKWebView. No Terminal, external browser, globally installed Node/Pi, or global extension installation is required to start it.

This release is **ad-hoc signed**, not signed with Developer ID and not notarized. macOS may block downloaded copies; review the source/checksum and use the normal **System Settings → Privacy & Security → Open Anyway** approval if appropriate. Do not disable Gatekeeper globally. The build machine has no Developer ID signing identity. Intel, signing/notarization and App Store distribution are not claimed.

Choose **Windows → Workspace** to select a project; the initial workspace is your home directory. Normal `~/.pi/agent` credentials/configuration remain usable but are not included in the app or changed by installation. A new user can select a provider and enter a server-lifetime API key in **Providers**. OAuth login/custom-provider setup still needs the corresponding upstream Pi setup; packaging does not add terminal-only features. Submitting prompts may incur provider charges; opening the app does not submit a prompt. Git and optional external-agent CLIs are not bundled: Git features require a working Git installation, and external CLI agent profiles need their own installed/authenticated runners.

The native window can be minimized/hidden and restored from the Dock or **View → Show Main Window**. Closing it hides it without killing a task. **⌘Q** requests current status, warns about active/incompletely observed jobs, then requests orderly backend shutdown. Detached pi-subagents jobs retain their upstream lifecycle and may outlive the app, particularly jobs from earlier main sessions; current-session telemetry cannot prove all detached jobs have finished. Finish or stop them before quitting. A service crash presents an error rather than silently launching a second writer or resending prompts.

Copy/paste/select-all, native alert/confirm/text-entry dialogs, Reload Interface and an About panel are provided. The local development build opens newly opened panels at their minimum usable width with a medium height, keeps that width and follows native height changes until you resize them yourself; manual sizes are saved. Separate Auto-size/↗ controls and the native sizing menu command have been removed. Arrange resets compact defaults (which open at the minimum width again); an explicitly requested one-shot reset can clear old window preferences. The background vibrates gently while stopped and visibly flows (thinking wanders, output streams up and down) while an agent is busy; reduced motion and manual pause still win. Native Reload forces a full document navigation and privately restores authentication rather than merely navigating back to a stripped token fragment. See the [unreleased feature audit](native-feature-audit.md). Links outside the exact local service origin are blocked; a user-initiated HTTP(S) link offers **Copy Link** instead of opening a browser or navigating the privileged webview. There is no generic JavaScript-to-native filesystem/shell bridge.

## Data and process boundaries

- Native data: `~/Library/Application Support/Pi Dither/` (preferences, `desktop-sessions`, kernel-backed SQLite single-instance lease).
- Browser layout/motion: WKWebView's standard per-application website data store, at the stable `http://127.0.0.1:4317` origin. Native window geometry uses macOS preferences.
- Existing web-mode `.local` stores and ordinary Pi history are **not migrated, copied, removed, or bundled**. App conversations can be resumed through Sessions after relaunch; startup itself creates a new main conversation.
- Resources inside the app are immutable at runtime. Project operations run in the selected workspace, never the bundle. Replacing the app does not replace user data.
- Swift starts the bundled Node directly using `Process`, not a shell. A private stdio handshake transfers the ephemeral authenticated URL in memory; it is never placed in process arguments or logs. The web UI removes the fragment and retains the token in its session storage as before.
- Authenticated loopback, Host/Origin checks, CSP, narrow static allowlist, private Pi bootstrap IPC and approved extension provenance are unchanged. A second native process cannot take the same data-directory SQLite exclusive lease; a hard crash releases that OS lock automatically. Port conflicts fail closed rather than attaching to an unknown service.
- Stdin EOF (including native shell exit/crash) asks the host to close its owned Pi sessions. Normal quit waits for backend exit. It does not indiscriminately kill extension-owned process groups or other Pi conversations. Force-killing the backend itself or whole-machine crashes cannot provide graceful cleanup guarantees.
- Main tools and delegated writers are **not an OS sandbox**. The manual child read-only ceiling is unchanged. Only the bundled approved pi-subagents package is explicitly loaded into main; unrelated installed extensions are not packaged.

## Reset window layout only

The local follow-up supports `--reset-window-layout`. First quit normally (finish active work first), then explicitly launch:

```sh
open "$HOME/Applications/Pi Dither.app" --args --reset-window-layout
```

This clears only the native `PiDitherMain` saved frame, `pi-desktop:layout:v1` and session-storage observer-dismissal keys prefixed `pi-desktop:delegated-closed:v1:`. The page reset runs before UI initialization at the exact private local origin; its script is removed after that first load, so Reload and later ordinary launches preserve newly chosen geometry. It never clears the whole website store or changes conversations, credentials, workspace preferences or motion settings. Normal app relaunch still starts a fresh main session; saved conversations remain available in Sessions.

## Build

Prerequisites: macOS/Apple Silicon, Xcode Command Line Tools, Node 22.23.2, installed **core Pi 0.85.1** and **pi-subagents 0.69.0**. These are build inputs only. Build offline; nothing is installed into the user's Pi profile.

```sh
npm run app:build
npm run test:macos
npm run app
```

To validate a development build without overwriting existing `dist/` artifacts, set `PI_DITHER_BUILD_DIR` to a dedicated output directory, then pass its app path through `PI_DITHER_TEST_APP` to `npm run test:macos`. The test refuses to start while another Pi Dither executable is running; it never stops that instance for you. Builds include `source-inventory.json` hashes of allowlisted app files and native/build inputs, checked against source by the native tests.

`PI_WORKSTATION_PI_ROOT` and `PI_DESKTOP_SUBAGENTS_ROOT` can point to those installed package roots for the build. `PI_DITHER_NODE_LICENSE` can locate the matching Node distribution LICENSE if it is not beside the runtime's `bin` directory. The packager rejects incompatible Pi/subagent versions and escaping runtime symlinks.

Outputs in ignored `dist/`:

- `Pi Dither.app`
- `Pi-Dither-0.4.0-macOS-arm64.zip`
- `SHA256SUMS.txt`

The packager copies only allowlisted application source, Node and installed public runtime packages. It does not copy the entire checkout, user profiles or credentials. Only pi-subagents and its dependency closure are bundled from the extension installation, not pi-web-search/pi-atelier or user agent definitions. Upstream license files stay alongside packages (including the core Pi monorepo's exact v0.85.1 MIT license, which its npm tarball omits); `Contents/Resources/runtime-inventory.json` records bundled versions and `THIRD-PARTY-NOTICES.txt` points to notices. Native binaries and the outer app are ad-hoc signed, verified and archived. Source remains plain JavaScript plus Swift; no Electron, React, frontend bundler or network-hosted assets.

## Validation and limitations

`npm run test:macos` copies the signed bundle to a path with spaces outside the checkout, uses an empty temporary Pi profile, strips the global runtime from PATH, opens the actual AppKit/WKWebView window through direct-executable and Finder/LaunchServices routes, checks connected empty main/bundled extension tools/no startup children/token removal, exercises all eight utility windows, native resizing/auto-size/manual preservation/maximize, draft create-close, dropdowns, motion, hide/reopen and Reload, then quits, and checks for surviving owned processes. The direct fixture also seeds stale layouts and unrelated preferences, verifies the selective one-shot reset, and proves Reload preserves subsequent manual geometry. It sends **no provider prompts**. Unit tests cover lease exclusivity/release, authenticated service startup and quit-state classification. Chromium/real-DOM/terminal checks remain separately available.

macOS 14 is the compilation/deployment floor, not a claim that every older macOS version has been manually tested. Full paid-provider streaming, real child billing/completion, Intel, exhaustive WebKit interactions/accessibility, distribution Gatekeeper approval and notarization remain outside this validation.
