#!/bin/bash
{{MARKER}}
# Claude SessionStart hook: a session running inside Odin learns to run what
# you'll watch in its Shell pane, not a background Bash. Outside Odin there's
# no pane to run it in, so it says nothing.
[ -n "$ODIN_PANE_ID" ] && [ -n "$ODIN_PORT" ] || exit 0
cat <<'ODIN_SHELL_RULE_JSON'
{{OUTPUT_JSON}}
ODIN_SHELL_RULE_JSON
