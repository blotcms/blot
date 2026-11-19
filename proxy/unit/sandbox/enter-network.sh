#!/bin/sh
# First step in a jail with a network (./jail.js). Loads the egress filter while
# the job still has capabilities in its own namespace, drops every one of them
# so it can't be undone, and becomes the job. A filter that doesn't load stops
# the job: it never runs without one.
set -eu

DIRECTORY=/usr/local/lib/blot-sandbox
resolver=$(awk '/^nameserver/ { print $2; exit }' /etc/resolv.conf)
[ -n "$resolver" ]

sed "s/__RESOLVER__/$resolver/g" "$DIRECTORY/egress.nft" > /tmp/egress.nft
nft -f /tmp/egress.nft
rm /tmp/egress.nft

# --ambient-caps and --inh-caps matter as well: nsjail's --keep_caps leaves
# ambient capabilities that would otherwise survive this exec
exec /bin/setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs "$@"
