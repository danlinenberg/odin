# Not the documented way in. The README hands out the DMG link directly and the
# app updates itself from GitHub releases, so nobody needs a tap to install or to
# upgrade. This stays because scripts/release.sh installs through it — one line
# that puts a freshly built release on this machine and checks the version it got.
cask "odin" do
  # ponytail: no pinned version/sha — the release workflow always publishes the
  # same asset name, so this tracks whatever is newest with nothing to bump.
  # Swap to a real version + sha256 if `brew upgrade` (without --greedy) or
  # installing an older build ever matters.
  version :latest
  sha256 :no_check

  url "https://github.com/danlinenberg/odin/releases/latest/download/Odin-arm64.dmg"
  name "Odin"
  desc "Personal work console for delegating to coding agents"
  homepage "https://github.com/danlinenberg/odin"

  depends_on arch: :arm64

  app "Odin.app"

  # No postflight here. Releases are signed with a self-signed certificate
  # rather than an Apple Developer ID, so macOS refuses to open the quarantined
  # copy and the README asks for one `xattr -dr com.apple.quarantine` after
  # installing. Automating that is currently a dead end: Homebrew 7 removed
  # --no-quarantine, deprecated `postflight` (which had `appdir` and
  # `system_command`), and its replacement `postflight_steps` is a restricted
  # step language with neither — `appdir` there raises "undefined local
  # variable".

  zap trash: [
    "~/.odin",
    "~/Library/Application Support/Odin",
    "~/Library/Logs/Odin",
    "~/Library/Preferences/com.dan.odin.plist",
    "~/Library/Saved Application State/com.dan.odin.savedState",
  ]
end
