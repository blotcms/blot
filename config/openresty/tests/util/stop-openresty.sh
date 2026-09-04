#!/bin/sh

# kill all openresty processes
PIDS=$(ps -ef | grep nginx | grep -v grep | awk '{print $2}')

if [ -z "$PIDS" ]; then
  echo "No openresty processes running"
else
  # openresty may have been started via sudo (see start-openresty.sh), so match
  # that when we aren't root ourselves.
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    KILL="sudo kill -9"
  else
    KILL="kill -9"
  fi

  for PID in $PIDS
  do
    echo "Killing nginx process $PID"
    $KILL "$PID"
  done
fi