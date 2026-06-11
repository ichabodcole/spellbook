#!/usr/bin/env bash
# watch-events.sh — canonical Monitor filter for Bounty Board events files.
#
# When an agent arms a Monitor in monitored host mode, the simplest correct
# invocation is:
#
#   Monitor({
#     persistent: true,
#     timeout_ms: 3600000,
#     command: "bash $CLAUDE_PLUGIN_ROOT/skills/bounty/scripts/watch-events.sh <events_file>"
#   })
#
# Each matching line on this script's stdout becomes a task-notification.
# Filter passes through everything an agent should react to:
#   - task.add / task.move / task.toggle / task.edit / task.remove
#     (user-driven board mutations)
#   - submit / cancel / closed
#     (session-ending events the agent must handle)
#
# Filtered OUT (noise or duplicates):
#   - meta, ready, connected, disconnected (lifecycle, agent already has
#     the meta line from the bg.ts spawn)
#   - message (toasts the agent itself usually posts)
#   - task.update broadcasts (these are server-side echoes of the
#     agent's own commands; reacting to them creates loops)

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: watch-events.sh <events_file>" >&2
  exit 2
fi

events_file="$1"

if [[ ! -e "$events_file" ]]; then
  echo "watch-events.sh: events file does not exist: $events_file" >&2
  exit 2
fi

# tail -F follows the file across truncation / rename (the bg.ts wrapper
# truncates on startup when --id reuses an existing path). --line-buffered
# on grep ensures each match is emitted immediately — Monitor needs
# per-line output, not pipe-buffered batches.
exec tail -F "$events_file" 2>&1 | grep -E --line-buffered \
  '"type":"task\.(add|move|toggle|edit|remove)"|"type":"submit"|"type":"cancel"|"type":"closed"'
