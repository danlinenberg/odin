#!/bin/bash
{{MARKER}}
# Claude SessionStart hook: a session running inside Odin learns to run what
# you'll watch in its Shell pane, not a background Bash, and to write its
# replies in ASD-STE100 Simplified Technical English and drafts in my voice.
# Outside Odin there's no pane to run it in, so it says nothing.
[ -n "$ODIN_PANE_ID" ] && [ -n "$ODIN_PORT" ] || exit 0
# Odin writes the voice guide in; if it doesn't answer, the rules alone.
curl -sf --max-time 3 "http://127.0.0.1:$ODIN_PORT/session-start" && exit 0
cat <<'ODIN_SHELL_RULE_JSON'
{{OUTPUT_JSON}}
ODIN_SHELL_RULE_JSON
