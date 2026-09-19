# Pi Dither macOS delivery plan

## Authorized outcome

Rename the project/application/GitHub repository to Pi Dither / `pi-dither`, package a self-contained macOS application, validate it, and publish the update to the existing private GitHub repository. Preserve the terminal interface and all existing local work. Do not bundle user credentials, sessions, `.local`, private agent profiles, or unrelated extensions.

## Implementation

- Native Swift/AppKit shell with a WKWebView, native Dock/menu/quit lifecycle, application icon and in-window startup/error handling. Main UI never launches Terminal or a separate browser. Out-of-app links cannot navigate the privileged webview.
- Bundle the existing Node 22.23.2, unchanged core Pi 0.85.1, pi-subagents 0.69.0 and their installed runtime dependencies. Build on the current architecture; first artifact targets Apple Silicon/macOS 14+. No global package installation.
- A private stdio native-host protocol starts the authenticated loopback service, supplies its URL directly to the webview, checks active/unknown tasks before quit, and stops owned Pi processes when the app exits. Tokens are not written to argv, files or logs. Detached extension jobs remain extension-owned; quit must warn rather than falsely promise cancellation.
- Native data lives outside the read-only bundle under `~/Library/Application Support/Pi Dither`. Keep a stable loopback origin for layout memory and a per-data-directory process lock against duplicate writers. Browser development remains an explicit optional command; terminal launchers remain supported.
- Build script copies only allowlisted application source and installed package contents; include licenses and a runtime inventory. Produce an ad-hoc-signed `.app` and ZIP. No claim of Developer ID signing/notarization/App Store distribution or Intel support.
- Tests: existing Node/Chromium/terminal coverage; native host auth/lock/quit/EOF and process cleanup; real WKWebView loading in an isolated temporary profile/data store without prompts; relocate bundle to prove it does not depend on checkout/runtime install locations; signature/inventory/archive inspection.
- Publication: inspect all staged paths and secrets/artifacts, commit the tested snapshot, rename the existing private repository without changing visibility, push fast-forward updates, attach the Apple Silicon archive/checksum to a versioned private release. Never force-push.

## Boundaries

No deployed desktop restart or saved-session migration. Native storage is separate from earlier checkout `.local` stores, which remain untouched. Existing user Pi configuration can still supply credentials; none is included in the artifact. Normal model requests remain potentially billable and are excluded from validation. Local packaging can use ad-hoc signatures; external recipients may encounter Gatekeeper warnings until the owner supplies Developer ID signing and notarization.

## Progress

- Confirmed name, private repository ownership and available Apple Silicon Swift/macOS SDK toolchain. Source checkout had pre-existing uncommitted v0.3 improvements and one user-created delegation-test document; all preserved. The unrelated test document is excluded from publication.
- Implemented AppKit/WKWebView shell, private native host, SQLite single-instance lease, native dialogs/navigation/quit controls, pixel icon and offline runtime packager. Core Pi remains unmodified. Added the exact upstream v0.85.1 MIT license (Git blob `b0a8e9b81083294360c69b4ec45d3d39a2b28197`) because its npm tarball omits the monorepo license.
- Fixed relocation through macOS `/var` → `/private/var` symlinks: the native-host CLI entry comparison now canonicalizes its path. A dedicated real-Pi symlink/EOF regression ensures the service cannot silently skip startup and leaves no owned processes behind.
- Passed **106/106** Node/real-DOM tests, integrated Chromium fixture browser, four real-Pi PTY scenarios, deep/strict signatures, and real AppKit/WKWebView launches through both direct executable and Finder/LaunchServices routes after moving the bundle outside the checkout. Tests use isolated data/profiles, no global runtime PATH dependency, no prompts; verify empty main, bundled extension/tool availability and process cleanup.
- Generated the Apple Silicon `.app`, ZIP and SHA-256 checksum. Ad-hoc signing only: no Developer ID identities are available. Historical plans retain design/acceptance evidence but local run identifiers and private artifact paths have been removed from their publishable copies; originals remain ignored/private.
