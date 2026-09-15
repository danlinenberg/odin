# Implementation details
For Electron interprocess communication, ALWAYS use trpc as defined in `src/lib/trpc`
Please use alias as defined in `tsconfig.json` when possible

## Every change ends as a merged PR

Work on Odin does not stop at "edited the working tree" — Dan's checkout is shared
with other agent sessions, so uncommitted work gets lost or tangled. Finish the job:
branch off `main`, commit, push, `gh pr create`, then `gh pr merge --squash
--delete-branch`. Standing instruction — don't ask first, and never push to `main`
directly.

Stage by path, never `git add -A`: this checkout almost always carries unrelated
modified files from other sessions.

## Never restart the dev Odin without asking first

Dan works *inside* the running dev app — the board, live agent sessions, your own
terminal. Anything that takes it down (`scripts/odin-dev.sh`, the "Restart Odin"
button, `pkill`, quitting Electron) interrupts him, and he is not watching your
terminal. Ask with a native popup and wait for the answer:

```bash
osascript -e 'display dialog "Restart Odin dev to pick up main-process changes?" with title "Odin" buttons {"Cancel","Restart"} default button "Restart"'
```

Exit 0 = go ahead; non-zero = he cancelled, leave the app running. Renderer edits
hot-reload on their own, so most changes need no restart at all — only edits under
`src/main/`, `src/lib/trpc/` and `src/preload/` do.

For the same reason `dev` runs `electron-vite dev` **without `--watch`**: with agents
editing this checkout, restart-on-save meant the app died every few seconds. Main-process
edits now wait for a deliberate restart (the "Restart Odin" button in the dev top bar, or
re-running `scripts/odin-dev.sh`). `ODIN_DEV_WATCH=--watch bun dev` brings the old
behaviour back.

Renderer saves carry the same hazard by a different route: some route modules (the
board is one) have no usable Fast Refresh boundary, so Vite gives up on HMR and
full-reloads the renderer — the whole app reboots, every pane remounts and re-attaches,
and it reads as "Odin restarted" mid-work. `coalesceFullReloadPlugin` in
`vite/helpers.ts` holds those full reloads until saves go quiet (10s, or 60s max), so a
busy fleet costs one reload instead of ten a minute. Hot updates are untouched, and Vite
still logs `page reload <file>` naming the module that dead-ended — chase that if you
want the boundary actually fixed.

Never kill a dev Electron process by path pattern: the terminal-host daemon and every
live terminal session (`pty-subprocess.js`) run the same `Odin Dev.app` binary out of the
same `node_modules`, so a path match closes real sessions. Kill the UI by pid.

## Server-driven announcements (desktop notices)

To show an announcement/warning popup in the app without shipping a release, insert a row in the `desktop_notices` table (served by `GET /api/desktop/version`). Authoring guide — markdown-only body, severities, triggers, targeting, QA previews: `docs/DESKTOP_NOTICES.md`.

## Persisted renderer state (localStorage) policy

Renderer localStorage has one ~10 MB quota, loads synchronously at boot, and keys outlive the code that wrote them — unbounded growth has frozen the renderer before (23.7 MB profile, GH #5496). Every writer must be allowlisted in `src/renderer/lib/persisted-keys/persisted-key-registry.test-data.ts` (CI fails on unregistered writers), and code review must answer three questions:

1. **What bounds it?** A cap/LRU, a TTL, reconciliation against an owning entity, or "fixed-size singleton". "It's small per write" is not a bound.
2. **Who deletes it?** New entity-keyed data belongs in SQLite; existing stores must document their deletion path or sunset plan because deletes from CLIs or other machines can bypass UI cleanup. One-shot payloads must be cleared by their consumer. Deleting a map entry means removing the key, never writing `null`.
3. **What happens when the feature dies?** Move the keys to `DEAD_KEYS` in the same PR that removes the writer; the boot sweep cleans existing profiles. Deleting the writer without registering the key strands it on user profiles forever.

Guardrail: localStorage is for small singleton UI state. Anything entity-scoped with unbounded cardinality, or payloads beyond a few KB, belongs in the SQLite persistence layer (`createElectronSQLitePersistence`) — localStorage collections re-serialize the whole org blob on every mutation.

## Window-drag regions: `drag` on empty leaves only

Never mark a container with interactive children as `drag` and carve the children out with `no-drag`: Chromium loses the carve-outs when they sit inside masked, scrollable, or CSS-zoomed wrappers (OverflowFadeContainer, ZoomStable), which silently deadens every control under the bar. Instead, put `drag` only on dedicated empty leaf elements — traffic-light spacers and flex fillers (see TopBar, DashboardSidebarHeader, packages/panes TabBar). The worst failure mode then is "empty area not draggable" instead of "chrome swallows clicks".

## Error text must be selectable

The renderer sets `user-select: none` on `body`, so rendered errors need explicit `select-text cursor-text` classes — otherwise users can't copy them into bug reports. (Sonner toasts are exempt; they manage selection themselves.)

## tRPC Subscriptions (trpc-electron)

**Important:** While standard tRPC recommends async generators for subscriptions, `trpc-electron` (used for Electron IPC) **only supports observables**. The library explicitly checks `isObservable(result)` and throws an error otherwise. Use the `observable` pattern:

```typescript
// CORRECT for trpc-electron - use observable pattern
import { observable } from "@trpc/server/observable";

export const createMyRouter = () => {
  return router({
    subscribe: publicProcedure.subscription(() => {
      return observable<MyEvent>((emit) => {
        const handler = (data: MyData) => {
          emit.next({ type: "my-event", data });
        };

        myEmitter.on("my-event", handler);

        return () => {
          myEmitter.off("my-event", handler);
        };
      });
    }),
  });
};

// WRONG for trpc-electron - async generators don't work with IPC transport
export const createMyRouter = () => {
  return router({
    subscribe: publicProcedure.subscription(async function* () {
      // This will NOT work - the generator never gets invoked
      while (true) {
        yield await getNextEvent();
      }
    }),
  });
};
```

## Verifying renderer changes via CDP

To check a change end-to-end against the real API/DB, drive the running dev app over CDP. Launch with an unused port, for example `RENDERER_REMOTE_DEBUG_PORT=9222 bun dev` (full stack; the app may restore a signed-in session), then attach via the page target's `webSocketDebuggerUrl` over a WebSocket (Bun built-in, no deps). Example: `scripts/cdp-smoke-integrations.ts`.

**Never assume port 9222 or attach to a renderer from another worktree.** Multiple Odin workspaces commonly run at once, each with different renderer, API, and CDP ports. Before testing:

1. Read this workspace's final `DESKTOP_VITE_PORT` and `NEXT_PUBLIC_API_URL` values from the root `.env`.
2. Find the Electron process whose executable/parent command path is inside this workspace. Its renderer command line contains `--remote-debugging-port=<port>`; `lsof -nP -iTCP -sTCP:LISTEN` can confirm the owning PID.
3. Fetch `http://127.0.0.1:<port>/json/list` and require a `page` target whose URL uses this workspace's `DESKTOP_VITE_PORT`. A responding CDP endpoint alone is not sufficient proof that it belongs to this branch.
4. Pass the matched values explicitly when using a script, e.g. `RENDERER_REMOTE_DEBUG_PORT=<port> NEXT_PUBLIC_API_URL=<api-origin> bun run apps/desktop/scripts/cdp-smoke-integrations.ts`.

Verify `/api/auth/get-session` from inside the matched renderer before testing.

### Repairing CDP auth

Check which setup script provisioned the workspace before repairing auth:

- `.odin/setup.local.sh` creates a per-workspace local stack and runs the idempotent `bun run db:seed-dev`, but intentionally leaves sign-in as a separate step. If the account may be missing, rerun `bun run db:seed-dev` while the local DB stack is running.
- `.odin/setup.sh` seeds `odin-dev-data/auth-token.enc` from `$HOME/.odin/auth-token.enc` when available. Rerunning it without `--force` can fill a missing token. Do not use `--force` merely to repair auth: it resets `odin-dev-data/` before reseeding.

The desktop hydrates a persisted token into an in-memory bearer-token closure. A raw `Runtime.evaluate` `fetch` cannot read that closure, and the local-dev sign-in button persists a bearer token but uses `credentials: "omit"`; neither guarantees the cookie required by a raw CDP probe. For a workspace created by `setup.local.sh`, repair the CDP session as follows:

1. Require a localhost API origin; never send dev credentials to a remote or shared API.
2. From `apps/desktop` (so workspace imports resolve), import `DEV_EMAIL` and `DEV_PASSWORD` from `@odin/shared/dev-credentials`; do not copy their literal values into scripts or logs.
3. Through `Runtime.evaluate` in the matched renderer, POST them to `${NEXT_PUBLIC_API_URL}/api/auth/sign-in/email` with JSON content type and `credentials: "include"`. Do not print the returned token or response body.
4. Re-fetch `/api/auth/get-session` with `credentials: "include"` and require both `session` and `session.activeOrganizationId` before running the test.

This credentialed local-dev sign-in creates the browser session cookie needed by subsequent in-renderer fetches. If it fails, report the sign-in/session status codes only. For a non-local setup, use the app's normal sign-in flow; never substitute local dev credentials.

For a non-local workspace, the normal desktop flow intentionally restores an encrypted bearer token into the renderer's in-memory auth client without creating a browser cookie. If the renderer is on an authenticated route but a raw cookie-only probe returns no session, use `Runtime.evaluate` to import `/lib/auth-client.ts` from the renderer dev server and call `authClient.getSession({ fetchOptions: { throw: false } })`. This still verifies `/api/auth/get-session` through the app's real authenticated request path. Return only the status and `session.activeOrganizationId`; never call or print `getAuthToken()`.

Do not use setup `--force` to fix a stale connection string, a missing CDP cookie, or a corrupt generated Next.js cache. First rerun the applicable setup script without force. If every API route returns Next.js's HTML 404, stop the dev stack, move `apps/api/.next` aside, and restart. `--force` is only appropriate when the user explicitly intends to replace the copied local/host databases and encrypted auth token.

One failure signature where `./.odin/setup.sh --force` IS the fix (verified 2026-07-28): session restore hangs at "Restoring your session", the Local Admin sign-in button returns a bodyless 500, get-session returns 200, and a raw `select 1` against `DATABASE_URL` may still succeed — the worktree's seeded dev state (Neon branch credentials in `.env`, `auth-token.enc`, copied DBs) has gone stale as a set. Rerunning with `--force` recreates the Neon branch, rewrites `.env`, and reseeds `odin-dev-data/` together, which restores sign-in. Two side effects to expect: any manual `.env` edits (e.g. a port remap) are wiped and must be re-applied, and `odin-dev-data/` is reset.

**Use `Runtime.evaluate` (`awaitPromise`, `returnByValue`), not `Network.*` interception** — sniffing misses React-Query-cached responses, and `refetchInterval` is paused while the window is backgrounded. After verifying the session through the applicable cookie or bearer path above, run requests inside the renderer. `API` below is the dev backend origin (`NEXT_PUBLIC_API_URL`, e.g. `http://localhost:5881`):

- Active org: local cookie flow uses `fetch(API + "/api/auth/get-session", {credentials:"include"})`; non-local bearer flow uses `authClient.getSession({ fetchOptions: { throw: false } })`. Require `.session.activeOrganizationId`.
- A tRPC query (bypasses the cache): GET `API + "/api/trpc/<proc>?batch=1&input=" + encodeURIComponent(JSON.stringify({"0":{json:<input>}}))`; response is `[{result:{data:{json:...}}}]`.
- `window.location.hash` nav may not remount the route — call the endpoint directly instead.
