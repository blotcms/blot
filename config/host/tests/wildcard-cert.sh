#!/bin/bash
# Tests config/host/wildcard-cert.sh with a stub redis-cli and throwaway
# certificates. No Docker, AWS or production access; needs only openssl.
# Usage: config/host/tests/wildcard-cert.sh
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../../.." && pwd)
SCRIPT=$REPO/config/host/wildcard-cert.sh
FAILED=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

ok() { echo "ok - $*"; }
fail() { echo "FAILED - $*"; FAILED=1; }
check() { # check <description> <command...>
  local what=$1
  shift
  if "$@"; then ok "$what"; else fail "$what"; fi
}
refuses() { ! "$@"; }
mode() { stat -c %a "$1" 2> /dev/null || stat -f %Lp "$1"; }

# A key and a self-signed certificate for it. openssl req cannot back-date, so
# the expired one is signed with openssl ca.
mkcert() { # mkcert <name>
  openssl req -x509 -newkey rsa:2048 -nodes -subj "/CN=wild.test" -keyout "$TMP/$1.key" -out "$TMP/$1.pem" -days 1 > /dev/null 2>&1
}
mkexpired() { # mkexpired <name>
  openssl genrsa -out "$TMP/$1.key" 2048 > /dev/null 2>&1
  openssl req -new -key "$TMP/$1.key" -subj "/CN=wild.test" -out "$TMP/$1.csr"
  mkdir "$TMP/ca"
  : > "$TMP/ca/index"
  echo 01 > "$TMP/ca/serial"
  cat > "$TMP/ca/ca.cnf" <<CNF
[ca]
default_ca = x
[x]
database = $TMP/ca/index
new_certs_dir = $TMP/ca
serial = $TMP/ca/serial
default_md = sha256
policy = p
unique_subject = no
[p]
commonName = supplied
CNF
  openssl ca -batch -config "$TMP/ca/ca.cnf" -selfsign -keyfile "$TMP/$1.key" -in "$TMP/$1.csr" \
    -startdate 20200101000000Z -enddate 20200102000000Z -out "$TMP/$1.pem" > /dev/null 2>&1
}

mkcert good
mkcert other
mkexpired expired
if openssl x509 -in "$TMP/expired.pem" -noout -checkend 0 > /dev/null 2>&1; then
  echo "test setup: the expired certificate is not expired"
  exit 1
fi
: > "$TMP/empty"

# Stub redis-cli: serves the files named by STUB_PEM and STUB_KEY, and prints
# nothing for a missing or empty one, as redis-cli --raw does for a missing key.
mkdir "$TMP/bin"
cat > "$TMP/bin/redis-cli" <<'EOS'
#!/bin/bash
[ "$1" = --raw ] && [ "$2" = get ] || exit 2
case $3 in
  blot:openresty:ssl:pem) f=$STUB_PEM ;;
  blot:openresty:ssl:key) f=$STUB_KEY ;;
  *) exit 3 ;;
esac
if [ -s "$f" ]; then cat "$f"; fi
echo
EOS
chmod +x "$TMP/bin/redis-cli"

run() { # run <pem file> <key file>; output in $TMP/out
  env PATH="$TMP/bin:$PATH" STUB_PEM="$1" STUB_KEY="$2" BLOT_CERT_DIR="$TMP/certs" \
    BLOT_CERT_OWNER="$(id -un):$(id -gn)" bash "$SCRIPT" --local > "$TMP/out" 2>&1
}
snapshot() { cat "$TMP/certs/letsencrypt-domain.pem" "$TMP/certs/letsencrypt-domain.key" | cksum; }
count() { ls -A "$TMP/certs" | wc -l | tr -d ' '; }

mkdir "$TMP/certs"
printf 'old pem\n' > "$TMP/certs/letsencrypt-domain.pem"
printf 'old key\n' > "$TMP/certs/letsencrypt-domain.key"
chmod 0640 "$TMP/certs"/*
before=$(snapshot)

check "empty key is refused" refuses run "$TMP/good.pem" "$TMP/empty"
check "empty key leaves the old files" [ "$(snapshot)" = "$before" ]
check "empty certificate is refused" refuses run "$TMP/empty" "$TMP/good.key"
check "empty certificate leaves the old files" [ "$(snapshot)" = "$before" ]
check "mismatched key is refused" refuses run "$TMP/good.pem" "$TMP/other.key"
check "mismatched key leaves the old files" [ "$(snapshot)" = "$before" ]
check "expired certificate is refused" refuses run "$TMP/expired.pem" "$TMP/expired.key"
check "expired certificate leaves the old files" [ "$(snapshot)" = "$before" ]
check "no temp files left after refusals" [ "$(count)" = 2 ]

check "a good pair is written" run "$TMP/good.pem" "$TMP/good.key"
check "certificate is the one in Redis" [ "$(openssl x509 -in "$TMP/certs/letsencrypt-domain.pem" -noout -fingerprint)" = "$(openssl x509 -in "$TMP/good.pem" -noout -fingerprint)" ]
check "key is the one in Redis" [ "$(openssl pkey -in "$TMP/certs/letsencrypt-domain.key" -pubout)" = "$(openssl pkey -in "$TMP/good.key" -pubout)" ]
check "certificate mode is 640" [ "$(mode "$TMP/certs/letsencrypt-domain.pem")" = 640 ]
check "key mode is 640" [ "$(mode "$TMP/certs/letsencrypt-domain.key")" = 640 ]
check "the key is not printed" refuses grep -q "PRIVATE KEY" "$TMP/out"
check "no temp files left after success" [ "$(count)" = 2 ]

chmod 0600 "$TMP/certs/letsencrypt-domain.key"
check "re-run succeeds" run "$TMP/good.pem" "$TMP/good.key"
check "re-run restores the mode" [ "$(mode "$TMP/certs/letsencrypt-domain.key")" = 640 ]
check "re-run reports already current" grep -q "already current" "$TMP/out"

exit "$FAILED"
