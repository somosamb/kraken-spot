#!/bin/sh
# Keeps exactly one runner alive. Single instance (flock), never revives after a
# confirmed PASS/BUST (HALTED file). Mode: ENTRY_ENABLED present -> auto, else noentry.
cd "$(dirname "$0")" || exit 1

exec 9>watchdog.lock
if ! flock -n 9; then
  echo "watchdog already running" >&2
  exit 0
fi

while true; do
  if [ -f HALTED ]; then
    sleep 300 9>&-
    continue
  fi
  if ! pgrep -f "^node runner\.mjs" >/dev/null 2>&1 9>&-; then
    echo "$(date -u +%FT%TZ) [WATCHDOG] runner down — restarting" >> watchdog.log
    if [ -f ENTRY_ENABLED ]; then
      setsid nohup node runner.mjs >/dev/null 2>>runner.err 9>&- < /dev/null &
    else
      setsid nohup node runner.mjs noentry >/dev/null 2>>runner.err 9>&- < /dev/null &
    fi
    sleep 3 9>&-
  fi
  sleep 45 9>&-
done
