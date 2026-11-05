#!/bin/bash
# Retires the EBS data volume: afterwards /var/www/blot/data is a plain
# directory on the root disk, at the same path, so the app and the containers'
# bind mount (/var/www/blot/data -> /usr/src/app/data, rslave) don't change.
# One-off (#2258, #2259). Run on the host as root, in this order:
#
#   retire.sh status
#   retire.sh overlay   copy the leftovers (everything but blogs/, git/ and the
#                       marker) into the root disk's directory underneath the
#                       mount, remove the docker drop-in and the mount unit,
#                       and mount that directory over the volume. The
#                       containers follow (shared -> rslave), so they write to
#                       the root disk from here on.
#   (deploy the app)    recreates the containers, so none still holds the
#                       volume underneath
#   retire.sh release   unmount the overlay and the volume in the host's
#                       namespace, leaving the root disk's directory, and check
#                       that no namespace holds the volume. Then detach it with
#                       the AWS CLI, by ID.
#
# --dry-run prints what each step would do. Nothing here deletes data: the
# volume is detached as it is, and the final snapshot is kept.
set -euo pipefail

DATA=/var/www/blot/data
ID_FILE=/etc/blot/data-volume
MARKER=.blot-data-volume
ROOT_VIEW=/run/blot-retire-root # a bind of / that shows what is under $DATA
UNDER=$ROOT_VIEW$DATA
UNITS="/etc/systemd/system/docker.service.d/20-data-volume.conf /etc/systemd/system/mount-data-volume.service"
DRY_RUN=""

die() { echo "error: $*" >&2; exit 1; }
run() { if [ -n "$DRY_RUN" ]; then echo "would: $*"; else "$@"; fi; }
devno() { printf '%d:%d' "0x$(stat -L -c %t "$1")" "0x$(stat -L -c %T "$1")"; }
mounts_at_data() { awk -v d="$DATA" '$5 == d' /proc/1/mountinfo | wc -l | tr -d ' '; }
top_dev() { awk -v d="$DATA" '$5 == d {x = $3} END {print x}' /proc/1/mountinfo; }
volume_id() { tr -d '[:space:]' < "$ID_FILE"; }
volume_dev() { devno "/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_$(volume_id | tr -d -)"; }
root_dev() { awk '$5 == "/" {print $3}' /proc/1/mountinfo; }
# Mount namespaces (one pid each) other than the host's that have the volume.
# holders <dev>: anywhere but at $DATA, as a container has it (at
# /usr/src/app/data); these keep the volume until they are recreated.
# holders <dev> all: anywhere at all, including services with systemd
# sandboxing (chronyd, logind, ...), which have it at $DATA as a slave of the
# host's mount, so the host's umount takes it from them too.
holders() {
  local no=$1 all=${2:-} host d ns seen=" "
  host=$(readlink /proc/1/ns/mnt)
  for d in /proc/[0-9]*; do
    ns=$(readlink "$d/ns/mnt" 2> /dev/null) || continue
    [ "$ns" != "$host" ] || continue
    case "$seen" in *" $ns "*) continue ;; esac
    seen="$seen$ns "
    awk -v n="$no" -v d="$DATA" -v a="$all" '$3 == n && (a || $5 != d) {f = 1} END {exit !f}' "$d/mountinfo" 2> /dev/null && echo "${d#/proc/} $(cat "$d/comm" 2> /dev/null)"
  done
  return 0
}
containers() { docker ps --format '{{.Names}}' | grep -E '^blot-(blue|green)$' || true; }
leftovers() { rsync -a --exclude "/blogs/" --exclude "/git/" --exclude "/$MARKER" "$DATA/" "$UNDER/"; }

cmd_status() {
  echo "mounts at $DATA: $(mounts_at_data) (top: $(top_dev); volume $(volume_dev 2> /dev/null || echo absent); root $(root_dev))"
  [ -f "$DATA/$MARKER" ] && echo "marker on top: $(cat "$DATA/$MARKER")" || echo "no marker on top"
  for u in $UNITS; do [ -e "$u" ] && echo "present: $u" || echo "gone: $u"; done
  echo "other namespaces holding the volume:"; holders "$(volume_dev)" | sed 's/^/  /'
  for c in $(containers); do echo "$c sees: $(docker exec "$c" sh -c "ls -A /usr/src/app/data | tr '\n' ' '")"; done
}

cmd_overlay() {
  [ "$(mounts_at_data)" = 1 ] || die "expected exactly one mount at $DATA (the volume), found $(mounts_at_data)"
  [ "$(top_dev)" = "$(volume_dev)" ] || die "$DATA is not the volume named in $ID_FILE"
  [ "$(cat "$DATA/$MARKER")" = "$(volume_id)" ] || die "the marker does not match $ID_FILE"
  findmnt -no PROPAGATION "$DATA" | grep -qx shared || die "$DATA is not shared: the containers would not follow"

  # A private bind of / shows the root disk's directory underneath the mount.
  run mkdir -p "$ROOT_VIEW"
  mountpoint -q "$ROOT_VIEW" || run mount --bind / "$ROOT_VIEW"
  run mount --make-private "$ROOT_VIEW"
  [ -n "$DRY_RUN" ] || [ -d "$UNDER" ] || die "$UNDER is missing"
  [ -n "$DRY_RUN" ] || [ -z "$(ls -A "$UNDER")" ] || echo "note: $UNDER is not empty: $(ls -A "$UNDER" | tr '\n' ' ')"
  run chown --reference="$DATA" "$UNDER"
  run chmod --reference="$DATA" "$UNDER"
  run leftovers

  for u in $UNITS; do [ ! -e "$u" ] || run mv "$u" "$u.retired"; done
  run systemctl daemon-reload

  run leftovers # again, as close to the switch as possible
  run mount --bind "$UNDER" "$DATA"
  run mount --make-shared "$DATA"
  [ -n "$DRY_RUN" ] && return 0
  [ "$(top_dev)" = "$(root_dev)" ] || die "the overlay is not on top at $DATA"
  for c in $(containers); do
    docker exec "$c" sh -c "test ! -e /usr/src/app/data/$MARKER && test ! -e /usr/src/app/data/blogs" ||
      die "$c still sees the volume at /usr/src/app/data"
    echo "$c follows: $(docker exec "$c" sh -c "ls -A /usr/src/app/data | tr '\n' ' '")"
  done
  echo "Overlay done. Next: deploy the app, then $0 release"
}

cmd_release() {
  local vol
  vol=$(volume_dev)
  [ "$(mounts_at_data)" = 2 ] || die "expected two mounts at $DATA (the overlay on the volume), found $(mounts_at_data)"
  [ "$(top_dev)" = "$(root_dev)" ] || die "the top mount at $DATA is not the root disk's directory: run overlay first"
  [ -z "$(holders "$vol")" ] || die "other namespaces still hold the volume (deploy the app first):
$(holders "$vol")"
  run umount "$DATA" # the overlay; the containers keep their own binds of the same directory
  run umount "$DATA" # the volume
  [ -n "$DRY_RUN" ] && return 0
  [ "$(mounts_at_data)" = 0 ] || die "$(mounts_at_data) mounts left at $DATA"
  [ -z "$(holders "$vol" all)" ] || die "the volume is still mounted somewhere: $(holders "$vol" all)"
  awk -v n="$vol" '$3 == n {f = 1} END {exit !f}' /proc/1/mountinfo && die "the volume is still mounted on the host"
  umount "$ROOT_VIEW" 2> /dev/null || true
  for c in $(containers); do echo "$c sees: $(docker exec "$c" sh -c "ls -A /usr/src/app/data | tr '\n' ' '")"; done
  sudo -u ec2-user test -w "$DATA" || die "$DATA is not writable by ec2-user"
  mv "$ID_FILE" "$ID_FILE.retired"
  echo "Released. Detach it by ID: aws ec2 detach-volume --volume-id $(cat "$ID_FILE.retired")"
}

[ "$(id -u)" = 0 ] || die "run as root"
[ "$(readlink /proc/self/ns/mnt)" = "$(readlink /proc/1/ns/mnt)" ] || die "not in the host's mount namespace"
[ "${2:-}" != --dry-run ] || DRY_RUN=1
case "${1:-}" in
  status) cmd_status ;;
  overlay) cmd_overlay ;;
  release) cmd_release ;;
  *) die "usage: $0 status | overlay | release [--dry-run]" ;;
esac
