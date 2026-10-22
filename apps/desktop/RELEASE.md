# Releasing the desktop app

```sh
scripts/release.sh          # patch bump
scripts/release.sh 1.19.0   # explicit version
scripts/release.sh --silent # no update banner: send its link to who needs it
scripts/release.sh --private # a draft no one else sees: send its DMG by hand
```

`--private` builds main on CI as a draft release, versioned as the next patch
with `-pre.<run>` (`1.0.22-pre.57`), and downloads the DMG to `~/Downloads`.
Drafts are visible only to the repo's collaborators, so nothing is public and
no updater sees it; the real `1.0.22` still updates whoever installed it. It
bumps no version on main. Delete the draft once it is sent, if you like:
`gh release delete <tag>`.

`--silent` publishes the release without marking it latest. The app's update
banner and the Homebrew cask both read `/releases/latest`, so neither offers
it; the script prints its own DMG link instead. The next normal release becomes
latest as usual, or `gh release edit <tag> --latest` promotes this one.

That is the whole flow. It bumps `apps/desktop/package.json` and
`packages/host-service/package.json` (they share a version) through a PR onto
`main`, dispatches the `Release` workflow, waits for the build, then upgrades
the Homebrew cask and clears the quarantine flag. About ten minutes, most of it
CI.

It runs off `origin/main` in a throwaway worktree, so it does not matter what is
checked out or dirty where you run it.

Not to be confused with `scripts/odin-update.sh`, which rebuilds *your* checkout
straight into `/Applications` and ships nothing.

## How it reaches a machine

`.github/workflows/release.yml` (public repo only) builds `Odin-arm64.dmg` and
attaches it to a release named for `apps/desktop/package.json`'s version. The
cask at `Casks/odin.rb` is `version :latest` and downloads
`releases/latest/download/Odin-arm64.dmg`, which is why the asset name never
changes and why `brew upgrade` needs `--greedy`.

Builds are signed ad-hoc, not with an Apple Developer ID, so every install needs
`xattr -dr com.apple.quarantine /Applications/Odin.app` - `release.sh` does it,
and the README tells everyone else to.

## Known gaps

- **Auto-update is inert.** `main/lib/auto-updater.ts` is wired up and looks for
  `latest-mac.yml`, but the workflow only uploads the `.dmg`, so there is no
  manifest to find. Brew is the only update path today.
- **arm64 macOS only.** No Intel or Linux leg; the cask declares
  `depends_on arch: :arm64`.

## Building locally

```sh
cd apps/desktop
bun run clean:dev
bun run compile:app
bun run package     # -> apps/desktop/release/
```

Native module errors usually mean `node-pty` fell out of externals in
`electron.vite.config.ts` or `electron-builder.ts`.
