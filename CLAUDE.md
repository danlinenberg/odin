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
every repo's linked worktrees, wherever they live, and removes worktrees whose work landed or whose
PR closed (Settings → Storage turns this off). It never removes one with
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

## Check main before you build

Before writing any code, check whether the feature or fix already exists on
`origin/main`. Many sessions work on this repo at once, and a request often
arrives after another session already shipped it.

- `git fetch origin main`, then search: `git log origin/main --oneline -i
  --grep=<keyword>` over recent PR titles, and `git grep -i <keyword>
  origin/main -- apps packages` for the code itself.
- Check open PRs too: `gh pr list --state open --search <keyword>`.

If it is already on main (or in an open PR), refuse and stop. Tell the user
which PR or commit has it, where the code lives (`file:line`), and how to reach
it in the app. If only part of it exists, say which part and offer to build
the rest. If the user insists after that, do the work as asked.

## Built for everyone

Odin is open source. Build every feature for any user: no code that only works
with, or only exists for, one company's AWS accounts, Claude plugins, repos,
Slack or Jira. When a request only serves one team, put it where that team owns
it (its own plugin or repo) instead. If it must touch Odin, make it a general
feature that team is just one user of.

## No company or personal data in the repo

The repo is public and its history is permanent. Odin is built from inside a
real job, so the bug reports, transcripts, Slack threads and terminal output you
work from are full of a real company's data. None of it goes into a commit:
code, tests, fixtures, comments, docs, commit messages or PR descriptions.

- Never: a real company, product or customer name, a colleague's name, email or
  GitHub handle, a work GitHub org or repo name, Slack/Jira/Sentry/Notion URLs
  or IDs from a real workspace, AWS account IDs, ARNs, internal hostnames or
  IPs, file paths from someone's machine, ticket keys, or any token, key or
  password (even an expired one).
- Turning a real report into a test? Rewrite every value first: `acme` for the
  company and org, `example.com` for domains and emails, `123456789012` for an
  AWS account, made-up names (`Alex`, `Riley Jones`), `C0123`/`U0123` for
  Slack IDs, `/Users/me/dev/app` for paths.
- Before you commit, grep your diff for the names of the company and people in
  the task you came from, and fix each hit.

## Nothing to install but Odin

No feature can be added if it means the user needs to install things to make it
work: no CLI (`op`, `gh`, `brew` packages), no helper app, no "install X first"
message or setup guide. Bundle what the feature needs inside Odin, or use an app
the user already has. If neither works, don't ship the feature.

## Writing

No em dashes anywhere: code, comments, UI strings, docs, commit messages, PR
descriptions. Use a plain hyphen `-`. `scripts/lint.sh` (CI's lint step) fails
on one.

No ponytail comments (the "ponytail" prefix on a note about a shortcut) in
anything committed. Say what the code does in a plain comment, or leave it out.
`scripts/lint.sh` fails on one.

## Keep the guide true

Huginn, Odin's raven, answers every question about Odin from
`apps/desktop/src/shared/odin-guide.ts`, so what the guide leaves out he says
Odin doesn't have. A change users can see - a screen, tab, button, setting,
connection, default, label or automation - updates the guide in the same PR, in
the words the user sees. Two checks hold this: `odin-guide-coverage.test.ts`
fails when a rail entry, Tasks tab, connection or setting is missing from it,
and CI's `guide` job has Claude read the diff and fails the PR with the
sentences to add.

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
