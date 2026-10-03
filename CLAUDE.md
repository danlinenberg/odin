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

If you forget, Odin runs `scripts/prune-worktrees.sh` every hour and removes
worktrees whose work landed. It never removes one with uncommitted files, with
commits main doesn't have, or touched in the last 24h (1h once its PR merged). `--dry-run` shows what
it would do.

**Why.** In a shared working tree `git checkout`, `git reset --hard` and
`git stash` are global: they rewrite every tracked file, including the ones
another session has open and uncommitted. Measured on this repo — local `main`
sat 40 commits stale for 28 hours while sessions kept branching off it, and one
`git stash` followed by `git pull --rebase` took 40 files and 1280 insertions
off disk in a single second. Nobody popped the stash. Uncommitted work in a
shared checkout has no owner.

`git stash` is blocked here by a `reference-transaction` hook for that reason.
Commit to a branch instead — a commit has an owner and survives a checkout.

## Committing

- Cut branches from `origin/main`, never from the branch the repo happens to be
  sitting on: it is routinely stale and often already squash-merged.
- Commit with an explicit pathspec — `git commit -m "..." -- <path>` — so a
  dirty index elsewhere can't ride along. `git show --stat HEAD` before pushing,
  and confirm the file list is exactly yours.
- Never `git add -A`. It sweeps up whatever another session left in the tree.
- Every PR is squash-merged, so `git branch --merged` never reports your branch
  as merged and is useless for spotting stale lanes. Compare content instead.

## Verifying

- `bun run compile:app` in `apps/desktop` is the build check that matters —
  it reaches entry points (`index.html`, the host-service and CLI bins) that
  nothing imports, so `tsc --noEmit` alone can miss a break.
- `bun run smoke` in `apps/desktop`, after `compile:app`, boots the built app in
  a throwaway home and clicks through the main flows (rail, Tasks, profiles,
  ⌘F, Settings). CI (`.github/workflows/ci.yml`) runs it on every PR after lint,
  typecheck and `bun run test`; a flow you change or add belongs in it.
- `routeTree.gen.ts` is generated and gitignored. A fresh worktree reporting a
  wall of missing-route errors just needs `bun run generate:routes`.
