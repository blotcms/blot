#!/bin/sh

CONFIG=$1

if [ -z "$CONFIG" ]; then
  echo "No config file specified"
  exit 1
fi

# macOS Homebrew puts openresty on PATH. Official Linux packages use
# /usr/local/openresty/bin/openresty. Alpine community packages install
# /usr/lib/nginx/bin/openresty (symlink to /usr/sbin/nginx).
if command -v openresty >/dev/null 2>&1; then
  OPENRESTY="$(command -v openresty)"
elif [ -x /usr/local/openresty/bin/openresty ]; then
  OPENRESTY="/usr/local/openresty/bin/openresty"
elif [ -x /usr/lib/nginx/bin/openresty ]; then
  OPENRESTY="/usr/lib/nginx/bin/openresty"
else
  echo "openresty executable not found"
  exit 1
fi

echo "Starting openresty with $OPENRESTY -c $CONFIG"

# nginx's `user` directive is only honoured when the master runs as root, so
# escalate with sudo when we aren't root already and sudo is available.
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  sudo "$OPENRESTY" -c "$CONFIG"
else
  "$OPENRESTY" -c "$CONFIG"
fi
