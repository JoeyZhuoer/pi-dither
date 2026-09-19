# Pi Desktop 0.2.0

## Visual direction

Based on the user-supplied retro desktop reference (`截屏2026-09-19 16.54.12.png`): dusty pink desktop, black ordered dithering, dark title bars, light gray windows, compact pixel labels, clock and Game-of-Life ornaments. The original image is not redistributed. The bundled VT323 font is licensed under SIL OFL 1.1; see `desktop/public/assets/OFL.txt`.

The main agent has the largest window. Subagent windows are draggable, resizable within smaller bounds, minimizable, and closable. Window geometry stays in localStorage; transcripts and credentials do not. The clock and Life pattern are decorative, not agent telemetry. Life is a static pattern, not a running simulation. Initial Scout/Review windows are visibly marked NOT STARTED.

## Run

```bash
npm run desktop
npm run desktop -- --project /absolute/project/path
# Without automatically opening a browser:
node desktop/server.mjs --project /absolute/project/path
# Change the local port:
PI_DESKTOP_PORT=4320 npm run desktop
```

Alternatively, open `Pi Desktop.command`. Core Pi must be version **0.85.1**. `PI_WORKSTATION_PI_ROOT` overrides discovery. The exact-version gate is deliberate: protocol assumptions need revalidation before an upgrade.

Use the authenticated URL printed in Terminal. It binds to `127.0.0.1`, not all interfaces. Closing the browser does **not** stop agents; Ctrl+C in the server Terminal stops its agents. A server restart creates a new token and a new main session. Sessions are saved by Pi under `.local/desktop-sessions/` (gitignored), not resumed automatically by the frontend. Reopening or refreshing the browser while the same server runs reconnects to its existing agents.

## Architecture

- `desktop/server.mjs`: dependency-free Node HTTP server, static allowlist, authenticated command API, state snapshots over fetch-based SSE, command request IDs, and agent process ownership.
- `desktop/pi-session.mjs`: one installed core `pi --mode rpc` process per real agent; LF JSON framing; correlated responses; bounded event projection; graceful process-group shutdown with a forced-kill fallback.
- `desktop/protocol.mjs`: streaming state reducer. `agent_end` is not considered settled; `agent_settled` handles retry/continuation completion. Tool partial results replace cumulative output rather than appending duplicates.
- `desktop/public/`: vanilla modules, local CSS/font, Canvas stippling, accessible title-bar controls, window layout and conversation views. No CDN, bundler, React dependency, or public network service.

The main agent retains core tools and configured provider credentials. A subagent launches with `--tools read,grep,find,ls`, a read-only system instruction, and its own session. Only the main agent can write using its normal tools. **This is a tool restriction, not an OS sandbox or protection against reading sensitive files.** Subagents share the working directory and may observe main-agent edits while inspecting it. There is no automatic parent/child transcript sharing, no automatic launch, and no integration with the installed pi-subagents extension. Handoff inserts the latest completed assistant result into the main editor; the user decides whether to send it.

All processes use `--offline --no-extensions --no-approve`. Offline prevents startup networking, not provider calls after a prompt. `--no-approve` ignores project-local settings and executable resource discovery; it is not a tool-execution approval mechanism. Global Pi provider configuration/auth and ordinary skills/prompts remain available. Custom providers implemented by disabled extensions are not supported. Model/thinking selection uses non-persisting RPC defaults.

## Security and execution behavior

- The API checks exact Host, Origin when present, Fetch Metadata, and a random bearer token. No wildcard CORS, cookies, URL query auth, public listener, or proxy support.
- The launch token starts in the URL fragment, is moved to sessionStorage, and is removed from the address bar. It is not embedded in served assets. Keep the printed URL private. Use a trusted browser profile: same-origin code with access to the token can operate the main agent's tools.
- Only selected model metadata crosses to the browser; provider keys, custom headers, and base URLs are not included in model responses. Tool output can still contain sensitive data the user/agent reads.
- Messages and tool output are rendered as text, not HTML. Simple fenced code blocks are supported; raw HTML, remote images, and automatic link execution are not.
- Mutating requests require IDs and are deduplicated within a bounded 256-entry server cache. This is not durable exactly-once execution. Lost acknowledgments do not trigger automatic resend. Inspect the transcript before manually retrying.
- Stop clears queued messages before aborting and returns pending text to the draft. Closing a subagent terminates its process rather than hiding a still-running agent. Minimizing does not terminate it.
- At most six real subagents plus the main agent. Browser history is bounded to 160 recent projected entries / roughly one million displayed characters; individual outputs are truncated. Pi's session files remain the full record. Large image/tool attachments are not forwarded to the browser.
- SSE reconnects with a complete current snapshot, not token-by-token replay. Backpressured clients are disconnected rather than allowed to exhaust server memory. Browser-tab drafts survive a reconnect, but are not persisted across page reloads.

## Validation

```bash
npm test
npm run test:terminal
# Real Chromium with an isolated temporary browser profile and a synthetic backend:
CHROME_PATH='/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' node tests/browser-smoke.mjs
```

`CHROME_PATH` can point to another Chromium executable. The script defaults to Chrome on macOS. This machine's Chrome headless startup failed with `FATAL:base/path_service.cc:264 Failed to get the path for 1001`; Edge's Chromium engine successfully ran the browser suite. No browser installation or default-browser changes were needed.

Completed checks:

- 14 Node tests total: eight existing terminal tests, six desktop tests (framing, streaming blocks, cumulative tool output, settled-vs-end lifecycle, model metadata filtering, API auth/static boundary/deduplication/manual child creation).
- Browser fixture: real 1440×960 rendering; token removal; largest-main hierarchy; pointer drag; keyboard resize; minimize/taskbar restore; Arrange; explicit subagent launch; safe hostile-text rendering; unsent handoff; 390px mobile layout without horizontal overflow; no frontend exceptions/resource/CSP errors.
- Same browser layout/control suite against the deployed **real Pi** main session (no synthetic messages and no prompts).
- Actual core RPC startup, model catalog, thinking levels, session identity, and usage initialization verified. Provider credentials were not copied into the browser.
- Screenshots captured and visually inspected locally under `.local/desktop-live.png` and `.local/desktop-fixture.png`. Screenshots are not tracked.

**Not certified:** live model streaming/billing, real-provider child completion, tool cancellation side effects, retry/compaction under provider failures, concurrent queued prompts, long-session memory behavior, Safari/Firefox, screen-reader behavior, IME, image input/output, extension UI dialogs, exhaustive trust/session workflows, or non-macOS process cleanup. Streaming/retry transitions have reducer tests; that is not end-to-end provider certification.

Use `Pi Workstation.command` / `npm start`, or ordinary core Pi, for the original terminal workflow and missing browser features. No core fork or default theme change is required.
