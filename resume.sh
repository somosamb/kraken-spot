#!/bin/sh
cd /home/oc/kraken-spot || exit 1
# Relaunch runner + watchdog if missing; never places orders.
if ! pgrep -f "^node runner\.mjs" >/dev/null 2>&1; then
  setsid nohup node runner.mjs >/dev/null 2>>runner.err < /dev/null &
  sleep 3
fi
if ! pgrep -f "^sh watchdog\.sh" >/dev/null 2>&1; then
  setsid nohup sh watchdog.sh >/dev/null 2>>runner.err < /dev/null &
  sleep 2
fi
# wait for a real cycle
sleep 50
node validate.mjs
node tests.mjs
