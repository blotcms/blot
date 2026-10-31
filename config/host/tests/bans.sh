#!/bin/bash
# Runs config/host/bans.sh against a stub ssh that runs the remote command
# locally, with stub sudo, fail2ban-client and sqlite3. Needs no docker.
# Addresses are RFC 5737 and RFC 3849 ones.
#
# Usage: config/host/tests/bans.sh
set -euo pipefail

BANS=$(cd "$(dirname "$0")/.." && pwd)/bans.sh
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

mkdir "$TMP/bin"
printf '#!/bin/bash\nwhile [ "$1" = -o ]; do shift 2; done\nshift\nexec bash -c "$*"\n' > "$TMP/bin/ssh"
printf '#!/bin/bash\nexec "$@"\n' > "$TMP/bin/sudo"
# The jail's bans now are in $TMP/jail; the database rows with bantime -1 are in $TMP/db.
cat > "$TMP/bin/fail2ban-client" <<EOS
#!/bin/bash
case "\$*" in
  "get manual-permaban banned") printf "["; sed "s/.*/'&'/" "$TMP/jail" | paste -sd, - | sed "s/,/, /g" | tr -d "\n"; echo "]" ;;
  "set manual-permaban banip "*) echo "\$4" >> "$TMP/jail"; echo "\$4" >> "$TMP/db"; echo 1 ;;
  *) exit 1 ;;
esac
EOS
printf '#!/bin/bash\ncat "%s"\n' "$TMP/db" > "$TMP/bin/sqlite3"
chmod +x "$TMP/bin"/*
export PATH="$TMP/bin:$PATH"

echo "# export"
# One ban in the jail, three rows in the database (one of them dropped by a restart, one a duplicate).
printf '%s\n' 198.51.100.0/24 > "$TMP/jail"
printf '%s\n' 2001:db8::/32 198.51.100.0/24 192.0.2.7 > "$TMP/db"
check "export succeeds" bash -c "'$BANS' export host '$TMP/out' > '$TMP/log' 2>&1"
check "the file is the sorted, unique union" bash -c "[ \"\$(cat '$TMP/out')\" = \"\$(printf '%s\n' 192.0.2.7 198.51.100.0/24 2001:db8::/32 | sort)\" ]"
check "it prints a count and no address" bash -c "grep -q 'Exported 3 bans' '$TMP/log'"
check "and leaks none" bash -c "! grep -qE '192\.0\.2|198\.51\.100|2001:db8' '$TMP/log'"
# A failing sqlite3 must leave the older file as it was.
printf '#!/bin/bash\nexit 1\n' > "$TMP/bin/sqlite3"
cp "$TMP/out" "$TMP/out.before"
check "a failed export fails" bash -c "! '$BANS' export host '$TMP/out' > '$TMP/log2' 2>&1"
check "and leaves the older file intact" cmp -s "$TMP/out" "$TMP/out.before"
printf '#!/bin/bash\ncat "%s"\n' "$TMP/db" > "$TMP/bin/sqlite3"

echo "# import"
: > "$TMP/jail"
: > "$TMP/db"
printf '%s\n' 192.0.2.7 198.51.100.0/24 2001:db8::/32 198.51.100.0/24 > "$TMP/in"
check "import succeeds" bash -c "'$BANS' import host '$TMP/in' > '$TMP/log3' 2>&1"
check "it banned each address once" bash -c "[ \"\$(sort '$TMP/jail')\" = \"\$(printf '%s\n' 192.0.2.7 198.51.100.0/24 2001:db8::/32 | sort)\" ]"
check "it prints counts" grep -q 'added 3, already banned 0, missing 0' "$TMP/log3"
check "and no address" bash -c "! grep -qE '192\.0\.2|198\.51\.100|2001:db8' '$TMP/log3'"
check "a second import skips what is banned" bash -c "'$BANS' import host '$TMP/in' > '$TMP/log4' 2>&1 && grep -q 'added 0, already banned 3' '$TMP/log4' && [ \"\$(wc -l < '$TMP/jail' | tr -d ' ')\" = 3 ]"
for bad in 192.0.2.256 192.0.2.0/33 2001:db8::/129 not-an-ip '192.0.2.1;ls' 2001:::1 1.2.3; do
  : > "$TMP/jail"
  printf '%s\n%s\n' 192.0.2.7 "$bad" > "$TMP/badin"
  check "a file with '$bad' is refused and nothing is banned" bash -c "! '$BANS' import host '$TMP/badin' > '$TMP/log5' 2>&1 && [ ! -s '$TMP/jail' ] && grep -q 'invalid' '$TMP/log5'"
done
check "and the refusal names no address" bash -c "! grep -qE '192\.0\.2\.7' '$TMP/log5'"
# A ban that does not stick makes import fail.
printf '#!/bin/bash\ncase "$*" in "get manual-permaban banned") echo "[]" ;; *) echo 1 ;; esac\n' > "$TMP/bin/fail2ban-client"
check "an address that is not listed afterwards fails the import" bash -c "! '$BANS' import host '$TMP/in' > '$TMP/log6' 2>&1 && grep -q 'missing 3' '$TMP/log6'"

[ "$FAILED" = 0 ] || { echo "Some checks failed"; exit 1; }
echo "All checks passed"
