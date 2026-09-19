# Desktop v0.3 implementation plan

> Historical implementation record. The owner later authorized publication as part of Pi Dither v0.4; earlier no-publication statements below describe the original implementation stage. See [macOS](macos.md) for current delivery.

## Implementation status

Implemented locally on `feat/desktop-v03`. The earlier v0.2 release was separately published to GitHub `main` at `7c1aaa4`; these new features have not been pushed.

The three isolated writers completed their bounded modules. Parent reviewed and integrated them, implemented the backend and public-SDK RPC host, and validated 46 tests (including opt-in real Chromium and the later usage-diagram/layout-memory regressions), the integrated browser UI, and real Pi metadata/session/provider controls without live model prompts. Read-only Git checks also disable configured clean/process filters, hooks, fsmonitor, external diff and textconv helpers. Remaining provider/platform/accessibility gaps are in `desktop.md`.

Follow-up features are implemented and validated separately in [`desktop-next-plan.md`](desktop-next-plan.md): the Window Manager utility is replaced by Tools, closed subagent numbers are reusable, and the backdrop flows with accessible pause controls. The combined suite now passes 68 tests plus browser and terminal checks; tool changes use a private public-SDK bridge. No follow-up publication is authorized.

The local v0.3 preview is configured for port 4319 and `.local/desktop-v03-preview/` storage so the existing v0.2 server/conversation is not replaced. The standard launcher defaults remain unchanged.

## Required deliverables

1. Safe Markdown rendering: headings, emphasis, lists, quotes, links, tables, fenced/inline code, and copy-code controls. No raw HTML or automatic remote image fetches.
2. Models & reasoning window: select an agent, provider, model, and supported thinking level using real Pi state.
3. Providers window: inspect configured providers; explicitly set/remove a temporary API-key override for supported built-in providers. Credentials stay server-side/in memory; never return keys or alter global auth. OAuth/custom endpoints remain terminal-managed.
4. Workspace window: directory browsing, recent/bookmarked roots, switch the working directory. Switching requires all agents idle and preserves saved sessions.
5. Git/worktrees window: real repository status, changed files, diff, worktree list, and open a selected worktree as workspace. No destructive Git operations.
6. Usage window: current session input/output/cache/total tokens, reported cost and context occupancy; all-agent view. Report unknown values honestly.
7. Sessions window: list/search desktop-owned sessions, resume, rename, new, clone, archive/restore (metadata only, never delete transcript files).
8. Activity window: actual run/tool/retry/queue activity, timestamps, focus and stop controls.
9. Window engine: all feature windows draggable/resizable, hide/show from menu/taskbar, focus, arrange, persisted geometry/visibility. The follow-up removes the separate manager/hide-all utility, not this engine. Default windows auto-enlarge on first explicit selection; manual layouts, maximize/restore and preferences survive hide/show/reload and temporary viewport clamping. Hiding is not stopping.
10. Desktop usage diagram replaces the decorative glider, following the selected agent's reported tokens/cache/cost/context with unknown, provisional and offline states kept honest. Uses existing SSE; no new backend requests or model prompts.

## Implementation ownership

The existing checkout has uncommitted user work. It is not committed or reset for orchestration. Three writers receive separate temporary snapshot repositories; the parent alone edits/integrates in the original checkout.

| Lane | Owned files/decision | Isolation | Gate |
| --- | --- | --- | --- |
| Markdown | `desktop/public/markdown.js`, `markdown.css`, dedicated tests | independent snapshot repo | syntax, parser/security tests; parent browser integration |
| Window manager | `desktop/public/windows.js`, optional `windows.css`, dedicated tests | independent snapshot repo | compatible API, persistence/accessibility tests; parent browser integration |
| Feature windows | `desktop/public/features.js`, `features.css`, dedicated tests | independent snapshot repo | contract-driven UI, no fake data; parent browser integration |
| Parent | backend APIs, core RPC lifecycle, app/HTML wiring, integration tests/docs | original checkout | auth/lifecycle/API tests, real Pi no-prompt smoke, browser suite |

Children may edit only their claimed files, cannot publish, and return evidence/risks via managed artifacts. Parent inspects and copies accepted files; no automatic merge or push.

## Frontend module contracts

`renderMarkdown(targetElement, text)` is exported from `/markdown.js`; it builds safe DOM. Parent calls it for assistant messages only and imports the CSS in HTML.

`DesktopWindows` keeps existing `add/remove/place/focus/arrange/windows` behavior. Add public `show(id)`, `hide(id)`, `toggle(id)`, `list()`, `rename(id,title)`, `onChange(callback)` (returns unsubscribe). `list()` returns `{id,title,kind,hidden,focused}`. `add({id,title,kind:'utility',index,hidden:true})` creates a non-destructive feature window: close means hide; persisted geometry/visibility applies. Subagent close keeps the existing explicit termination callback. Utility windows are not constrained to subagent-small bounds. Existing agent selectors/classes remain compatible.

`installFeatureWindows({windows, api, toast, getState})` from `/features.js` returns `{open(id), update(snapshot), dispose()}`. `getState()` / `update()` provide `{agents: [agentState...], cwd, connected}`. `api(path, body?)` performs authenticated GET or POST and throws readable errors; POST request IDs are added by parent. Stable utility IDs: `models`, `providers`, `workspace`, `git`, `usage`, `sessions`, `activity`, `tools` (the follow-up replaces the original `windows` utility). All are initially hidden; open from the menu. Keep user input stable across stream updates, refresh only necessary data, show loading/error/empty states, and never auto-launch agents or paid requests.

## Backend contracts

Existing `POST /api/agents/:id/model|thinking|prompt|stop|new|close` stay intact. `refresh` is added. Models/thinking state lives on each agent (`models`, `model`, `levels`, `thinking`, `phase`, `connected`). Mutating controls need connected/idle checks; stop is usable when busy.

- `GET /api/providers` -> `{providers:[{id,name,configured,canConfigure,temporaryOverride}],scope:'server-lifetime'}`.
- `POST /api/providers/configure` body `{provider,apiKey}` or `{provider,remove:true}` -> `{ok:true}`. Require all agents idle. Reconnect agents to apply SDK runtime overrides via private fd-3 bootstrap, preserving persisted sessions. Keys never echoed. Explain that keys are not provider-validated until a real request; OAuth is terminal-managed.
- `GET /api/workspace?path=<optional-directory>` -> `{cwd,recent:[{path,name}],listingPath,parent,entries:[{name,path,type:'directory'|'file'}]}`.
- `POST /api/workspace` body `{path}` -> `{cwd}`. All agents must be idle; creates a new main session there and closes old desktop-owned agents only. Confirm in UI.
- `POST /api/workspace/remember|forget` body `{path}` -> `{ok:true}`. Bookmark only, no filesystem deletion.
- `GET /api/git` -> `{isRepo,root,branch,head,dirty,files:[{status,path}],worktrees:[{path,branch,head,bare,detached,locked,prunable,current}],error?}`.
- `GET /api/git/diff` -> `{diff,truncated}`. Text display, no HTML injection; read-only commands.
- `GET /api/sessions` -> `{sessions:[{key,name,cwd,updated,messageCount,preview,active,archived}],scope:'Desktop sessions'}`. Session keys are server-owned opaque identifiers, never arbitrary client paths.
- `POST /api/sessions/resume` body `{key}` -> `{cwd}`. Idle-only; restores transcript/model and session cwd. Confirm current session replacement.
- `POST /api/sessions/rename` body `{key,name}` -> `{ok:true}`. Safe rename using core session APIs; active owner RPC if applicable.
- `POST /api/sessions/clone` body `{}` -> `{ok:true}`. Clone current main session through core RPC.
- `POST /api/sessions/archive` body `{key,archived:boolean}` -> `{ok:true}`. Cannot archive an active session; never deletes files.
- `GET /api/usage` -> `{agents:[{id,name,kind,sessionId,stats,currentUsage}]}`. Stats: `{tokens:{input,output,cacheRead,cacheWrite,total},cost,contextUsage:{tokens,contextWindow,percent},userMessages,assistantMessages,toolCalls,totalMessages}`. Nullable unknowns. `currentUsage` is provisional provider-reported active-message usage, not to be added blindly to authoritative stats.
- Agent state adds `sessionName`, `cwd`, `startedAt`, `lastActivityAt`, `currentTool`, `activity:[{id,at,type,label}]`, `currentUsage`. Activity history is bounded; absence of activity does not imply a hung process.

## Acceptance and boundaries

No paid prompts during automated tests. No changes to user's global Pi settings, credentials, Git branches, or tracked project content through validation. Use temporary fixtures for mutation tests. Preserve HTTP auth/Origin/Host protections and never render returned text as executable HTML. Test session/workspace/provider transitions for races and lost history; refuse mutations while agents run. Baseline terminal interface must still pass its tests. Final claims distinguish real Pi metadata/control checks from synthetic streaming tests.
