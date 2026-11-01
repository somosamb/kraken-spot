#!/bin/sh
# Keeps exactly one runner alive. Single instance (flock), never revives after a
# confirmed PASS/BUST (HALTED file). Mode: ENTRY_ENABLED present -> auto, else noentry.
# On Termux it also holds the wake lock so Android cannot suspend the CPU (the software
# stop needs every cycle). KS_WAKELOCK=0 disables it.
cd "$(dirname "$0")" || exit 1

exec 9>watchdog.lock
if ! flock -n 9; then
  echo "watchdog already running" >&2
  exit 0
fi

# Termux wake lock: app-wide and idempotent. Run in the background with a hard 20 s limit
# (it can be slow or hang). Never released here: other Termux processes may rely on it.
wakelock() {
  [ "${KS_WAKELOCK:-1}" = "0" ] && return 0
  command -v termux-wake-lock >/dev/null 2>&1 || return 0
  ( timeout -s KILL 20 termux-wake-lock </dev/null >/dev/null 2>&1 9>&- \
      && echo "$(date -u +%FT%TZ) [WATCHDOG] wake lock acquired" >> watchdog.log ) 9>&- &
}

wakelock
loops=0
while true; do
  loops=$((loops + 1))
  [ $((loops % 60)) -eq 0 ] && wakelock      # re-assert ~every 45 min (Termux may restart)
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
