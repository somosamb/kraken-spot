#!/bin/sh
# Safe stop: watchdog first (so it cannot revive the runner), then wait for any in-flight
# trader cycle to finish (up to 90 s) so no buy/sell is cut in half, then stop the runner.
pkill -f "^(/bin/)?sh (\./)?watchdog\.sh$" 2>/dev/null
i=0
while pgrep -f "^(/usr/bin/)?node .*trader\.mjs loop" >/dev/null 2>&1 && [ "$i" -lt 90 ]; do
  sleep 1
  i=$((i + 1))
done
pkill -f "^node runner\.mjs" 2>/dev/null
if pgrep -f "^(/usr/bin/)?node .*trader\.mjs loop" >/dev/null 2>&1; then
  echo "warning: a cycle was still running after 90 s and was left to finish on its own"
fi
echo done
