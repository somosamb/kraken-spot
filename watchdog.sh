#!/bin/sh
cd /home/oc/kraken-spot || exit 1
while true; do
  if ! pgrep -f "^node runner\.mjs" >/dev/null 2>&1; then
    echo "$(date -u +%FT%TZ) [WATCHDOG] runner down — restarting" >> watchdog.log
    if [ -f /home/oc/kraken-spot/ENTRY_ENABLED ]; then
      setsid nohup node runner.mjs >/dev/null 2>>runner.err < /dev/null &
    else
      setsid nohup node runner.mjs noentry >/dev/null 2>>runner.err < /dev/null &
    fi
    sleep 3
  fi
  sleep 45
done
