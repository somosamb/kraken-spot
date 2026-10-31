#!/bin/sh
# Post-reboot restore: revive watchdog (which revives the runner), wait for a real
# cycle, then run consistency checks and unit tests. Never places orders by itself.
cd "$(dirname "$0")" || exit 1
sh kspot
sleep 60
node validate.mjs
node tests.mjs
