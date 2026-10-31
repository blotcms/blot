#!/usr/bin/env bash
#
# Checks which host scripts/deploy/units.sh and util/sshCommand.js ssh to
# (BLOT_DEPLOY_TARGET, default blot), with a stub ssh first on PATH that only
# records its first argument. Needs no network:  bash scripts/deploy/tests/target.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/../../.."
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir "$T/bin"
cat > "$T/bin/ssh" <<'F'
#!/usr/bin/env bash
echo "$1" >> "$SSH_LOG"
# units.sh pipes a tar in, so keep reading; sshCommand.js leaves stdin open
# (exec), which would block until its 60s abort, so js() skips the read.
[ -n "${SSH_STUB_NO_STDIN:-}" ] || cat > /dev/null
F
chmod +x "$T/bin/ssh"
export PATH="$T/bin:$PATH" SSH_LOG="$T/ssh.log" SKIP_BRANCH_CHECK=true
unset BLOT_DEPLOY_TARGET

fail=0
check() { # name, expected, actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected '$2', got '$3'"; fail=1; fi
}
# Each prints the exit status and leaves the ssh targets used in $SSH_LOG.
units() { : > "$SSH_LOG"; bash "$ROOT/scripts/deploy/units.sh" HEAD > "$T/out" 2>&1; echo $?; }
js() { : > "$SSH_LOG"; SSH_STUB_NO_STDIN=1 node -e 'require(process.argv[1])("echo hi").then(() => process.exit(0), e => { console.error(e.message); process.exit(1) })' "$ROOT/scripts/deploy/util/sshCommand.js" > "$T/out" 2>&1; echo $?; }
targets() { sort -u "$SSH_LOG" | tr '\n' ' '; }

check "units.sh default exits 0" 0 "$(units)"
check "units.sh default ssh target" "blot " "$(targets)"
check "units.sh default prints no target line" 0 "$(grep -c 'ssh target' "$T/out")"
check "sshCommand default exits 0" 0 "$(js)"
check "sshCommand default ssh target" "blot " "$(targets)"

export BLOT_DEPLOY_TARGET=ec2-user@10.0.0.7
check "units.sh custom exits 0" 0 "$(units)"
check "units.sh custom ssh target" "ec2-user@10.0.0.7 " "$(targets)"
check "units.sh custom prints the target" 1 "$(grep -c 'Deploying to ssh target: ec2-user@10.0.0.7' "$T/out")"
check "sshCommand custom exits 0" 0 "$(js)"
check "sshCommand custom ssh target" "ec2-user@10.0.0.7 " "$(targets)"

for bad in "-oProxyCommand=x" "blot;touch x" "a b" '$(id)'; do
  export BLOT_DEPLOY_TARGET="$bad"
  check "units.sh refuses '$bad'" 1 "$(units)"
  check "units.sh '$bad' never runs ssh" "" "$(targets)"
  check "sshCommand refuses '$bad'" 1 "$(js)"
  check "sshCommand '$bad' never runs ssh" "" "$(targets)"
done

exit $fail
