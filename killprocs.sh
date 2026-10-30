#!/bin/sh
for p in $(ps -eo pid=,args= | awk '/node runner\.mjs/ && !/awk/ {print $1}'); do kill "$p" 2>/dev/null; done
for p in $(ps -eo pid=,args= | awk '/sh watchdog\.sh/ && !/awk/ {print $1}'); do kill "$p" 2>/dev/null; done
sleep 2
echo done
