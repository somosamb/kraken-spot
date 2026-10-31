#!/bin/sh
# Stop watchdog first (so it cannot revive the runner), then the runner and any in-flight cycle.
pkill -f "^(/bin/)?sh (\./)?watchdog\.sh$" 2>/dev/null
pkill -f "^node runner\.mjs" 2>/dev/null
sleep 2
pkill -f "trader\.mjs loop" 2>/dev/null
echo done
