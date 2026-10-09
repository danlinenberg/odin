#!/bin/bash
# Prevent infinite recursion during postinstall
# electron-builder install-app-deps can trigger nested bun installs
# which would re-run postinstall, spawning hundreds of processes

if [ -n "$ODIN_POSTINSTALL_RUNNING" ]; then
  exit 0
fi

export ODIN_POSTINSTALL_RUNNING=1

# Run sherif for workspace validation
sherif

# GitHub CI runs multiple Bun install jobs that do not need desktop native rebuilds.
# Running electron-builder here can trigger nested Bun installs while the main
# install is still materializing packages, which has been flaky with native deps.
if [ -n "$CI" ]; then
  exit 0
fi

# native-keymap builds with warnings-as-errors, and Electron 40's V8 headers
# deprecate an API it calls (C4996). MSVC appends _CL_ after the project's own
# flags, so it wins. release.yml sets the same for the Windows build.
if [ "$OS" = "Windows_NT" ]; then
  export _CL_="${_CL_:+$_CL_ }-wd4996"
fi

# Install native dependencies for desktop app
bun run --filter=@odin/desktop install:deps
