# Working on Odin with an agent

Several agent sessions run against this repo at once. Assume another session is
editing the same checkout right now.

## Take your own worktree first

```sh
scripts/session-worktree.sh <name>          # -> .worktrees/<name>
```

It cuts a fresh branch from `origin/main` and runs `bun install` there (~20s
warm), so `bun test`, `tsc` and `biome` work immediately. Work only inside it.
Once the PR is merged:

```sh
git worktree remove .worktrees/<name>
```

If you forget, Odin runs `scripts/prune-worktrees.sh` every 10 minutes over
every repo with a `.worktrees/` and removes worktrees whose work landed or whose
PR closed (Settings → Sessions turns this off). It never removes one with
commits its default branch doesn't have, or with no commits and touched in the
last 24h. Uncommitted files
keep a worktree for 7 days; after that they're committed to
`refs/pruned/<name>` first, and `git checkout refs/pruned/<name> -- .` brings
them back. `--dry-run` shows what it would do.

**Why.** In a shared working tree `git checkout`, `git reset --hard` and
`git stash` are global: they rewrite every tracked file, including the ones
another session has open and uncommitted. Measured on this repo - local `main`
sat 40 commits stale for 28 hours while sessions kept branching off it, and one
`git stash` followed by `git pull --rebase` took 40 files and 1280 insertions
off disk in a single second. Nobody popped the stash. Uncommitted work in a
shared checkout has no owner.

`git stash` is blocked here by a `reference-transaction` hook for that reason.
Commit to a branch instead - a commit has an owner and survives a checkout.

## Writing

No em dashes anywhere: code, comments, UI strings, docs, commit messages, PR
descriptions. Use a plain hyphen `-`. `scripts/lint.sh` (CI's lint step) fails
on one.

## Committing

- Cut branches from `origin/main`, never from the branch the repo happens to be
  sitting on: it is routinely stale and often already squash-merged.
- Commit with an explicit pathspec - `git commit -m "..." -- <path>` - so a
  dirty index elsewhere can't ride along. `git show --stat HEAD` before pushing,
  and confirm the file list is exactly yours.
- Never `git add -A`. It sweeps up whatever another session left in the tree.
- Every PR is squash-merged, so `git branch --merged` never reports your branch
  as merged and is useless for spotting stale lanes. Compare content instead.

## Verifying

- `bun run compile:app` in `apps/desktop` is the build check that matters -
  it reaches entry points (`index.html`, the host-service and CLI bins) that
  nothing imports, so `tsc --noEmit` alone can miss a break.
- `bun run smoke` in `apps/desktop` boots the built app in a throwaway home
  and clicks through the main flows (rail, Tasks, profiles, ⌘F, Settings, a
  session on a fake `claude` through to Done). CI (`.github/workflows/ci.yml`)
  runs it on every PR, beside lint, typecheck and `bun run test`. Don't run it
  locally unless Dan asks: each run opens another Odin on his screen. Read the
  CI result instead. A flow you change or add belongs in it.
- `routeTree.gen.ts` is generated and gitignored. A fresh worktree reporting a
  wall of missing-route errors just needs `bun run generate:routes`.
