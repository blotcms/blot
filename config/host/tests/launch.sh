#!/bin/bash
# Tests config/host/launch.sh with a stub aws, ssh and nc and a stub bootstrap.sh
# that record their arguments: no Docker, no AWS, no ssh. The stubs are on PATH
# (aws, ssh, nc) and next to a copy of launch.sh (bootstrap.sh).
#
# Usage: config/host/tests/launch.sh   (also run it with /bin/bash on a Mac: 3.2)
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FAILED=0

ok() { echo "ok - $*"; }
fail() { echo "FAILED - $*"; FAILED=1; }

mkdir -p "$TMP/bin" "$TMP/host" "$TMP/home/.ssh"
export HOME="$TMP/home"  # so launch.sh can never read the real ~/.ssh
unset BLOT_DEPLOY_PUBLIC_KEY
cp "$REPO/config/host/launch.sh" "$TMP/host/launch.sh"
touch "$TMP/key"
echo "ssh-ed25519 AAAAtest test@example.com" > "$TMP/deploy.pub"

# gh prints STUB_GH_KEY, or fails when it is empty.
cat > "$TMP/bin/gh" << 'EOF'
#!/bin/bash
echo "$*" >> "$STUB_DIR/gh.log"
[ -n "${STUB_GH_KEY:-}" ] || exit 1
echo "$STUB_GH_KEY"
EOF
chmod +x "$TMP/bin/gh"

# Each stub appends one line per call to its log (arguments joined by spaces).
cat > "$TMP/bin/aws" << 'EOF'
#!/bin/bash
a="$*"; echo "${a//$'\n'/\\n}" >> "$STUB_DIR/aws.log"
case "$*" in
  *"ssm get-parameter"*) echo ami-test ;;
  *"describe-images"*) echo /dev/xvda ;;
  *"run-instances"*) echo i-test ;;
  *"describe-instances --instance-ids"*) echo "$STUB_ADDRESSES" ;;
esac
EOF
cat > "$TMP/bin/ssh" << 'EOF'
#!/bin/bash
echo "$*" >> "$STUB_DIR/ssh.log"
EOF
# The exit status is what STUB_NC_EXIT says: 0 means the port connected.
cat > "$TMP/bin/nc" << 'EOF'
#!/bin/bash
echo "$*" >> "$STUB_DIR/nc.log"
exit "$STUB_NC_EXIT"
EOF
cat > "$TMP/host/bootstrap.sh" << 'EOF'
#!/bin/bash
echo "$* REDIS_MAXMEMORY=[$REDIS_MAXMEMORY] SSH_OPTS=[$SSH_OPTS] BLOT_SSH_PORT=[$BLOT_SSH_PORT] BLOT_DEPLOY_PUBLIC_KEY=[$BLOT_DEPLOY_PUBLIC_KEY]" >> "$STUB_DIR/bootstrap.log"
EOF
chmod +x "$TMP/bin/aws" "$TMP/bin/ssh" "$TMP/bin/nc" "$TMP/host/bootstrap.sh" "$TMP/host/launch.sh"

# run <args...>: launch.sh with the stubs; sets OUT, STATUS and the logs.
# STUB_ADDRESSES (public and private) and STUB_NC_EXIT set what the stubs answer.
run() {
  rm -f "$TMP"/*.log
  STATUS=0
  OUT=$(STUB_DIR="$TMP" STUB_ADDRESSES="${STUB_ADDRESSES:-None 10.0.0.5}" STUB_NC_EXIT="${STUB_NC_EXIT:-1}" STUB_GH_KEY="${STUB_GH_KEY:-}" PATH="$TMP/bin:$PATH" "$TMP/host/launch.sh" "$@" 2>&1) || STATUS=$?
  AWS_LOG=$(cat "$TMP/aws.log" 2> /dev/null || true)
  SSH_LOG=$(cat "$TMP/ssh.log" 2> /dev/null || true)
  BOOTSTRAP_LOG=$(cat "$TMP/bootstrap.log" 2> /dev/null || true)
  NC_LOG=$(cat "$TMP/nc.log" 2> /dev/null || true)
}
# has <description> <text> <pattern>
has() { if printf '%s\n' "$2" | grep -qF -- "$3"; then ok "$1"; else fail "$1 (no '$3' in: $2)"; fi; }
lacks() { if printf '%s\n' "$2" | grep -qF -- "$3"; then fail "$1 (found '$3')"; else ok "$1"; fi; }

COMMON=(--type m6gd.xlarge --key-name test-key --key "$TMP/key" --redis-maxmemory 1gb --deploy-public-key "$TMP/deploy.pub")

run --dry-run --type m6gd.xlarge --key-name test-key
[ "$STATUS" -eq 0 ] && ok "dry run exits 0 without --key" || fail "dry run exits 0 without --key: $OUT"
lacks "dry run does not call run-instances" "$AWS_LOG" "run-instances"
has "dry run prints the command" "$OUT" "would run: aws"

run "${COMMON[@]}"
[ "$STATUS" -eq 0 ] || fail "normal launch exits 0: $OUT"
has "launch passes the maxmemory to bootstrap" "$BOOTSTRAP_LOG" "REDIS_MAXMEMORY=[1gb]"
RUN=$(printf '%s\n' "$AWS_LOG" | grep run-instances)
has "launch passes the type" "$RUN" "--instance-type m6gd.xlarge"
has "launch passes the key name" "$RUN" "--key-name test-key"
has "launch passes the subnet" "$RUN" "--subnet-id subnet-4a78973d"
has "launch passes both security groups" "$RUN" "--security-group-ids sg-0d1c2c28e0c7084ad sg-0b3b200323d36ce2e"
has "launch requires IMDSv2" "$RUN" "HttpTokens=required,HttpPutResponseHopLimit=1"
has "launch sets termination protection" "$RUN" "--disable-api-termination"
has "launch uses the AMI's root device" "$RUN" '"DeviceName":"/dev/xvda"'
has "launch defaults the root to 200 GB gp3" "$RUN" '"VolumeSize":200,"VolumeType":"gp3"'
has "launch names the host app-*" "$RUN" "Key=Name,Value=app-"
has "launch tags the provisioner" "$RUN" "Key=HostProvisionedBy,Value=config/host/launch.sh"
lacks "no instance profile by default" "$RUN" "--iam-instance-profile"
lacks "no user data without --ssh-port" "$RUN" "--user-data"
lacks "a real launch has no drill tag" "$RUN" "BlotDrill"
has "launch bootstraps the address" "$BOOTSTRAP_LOG" "ec2-user@10.0.0.5"
has "launch prints the next step" "$OUT" "PUBLIC_IP=10.0.0.5"
has "the next step runs deploy.sh directly" "$OUT" " config/host/deploy.sh"
lacks "the next step avoids npm, which would target production" "$OUT" "npm run deploy-host"
has "launch waits for ssh on port 22" "$SSH_LOG" "-p 22 "

run "${COMMON[@]}" --root-gb 300 --instance-profile test-profile --tag Owner=test
has "--root-gb sets the size" "$AWS_LOG" '"VolumeSize":300'
has "--instance-profile is passed" "$AWS_LOG" "--iam-instance-profile Name=test-profile"
has "--tag is passed" "$AWS_LOG" "{Key=Owner,Value=test}"

run "${COMMON[@]}" --drill
RUN=$(printf '%s\n' "$AWS_LOG" | grep run-instances)
lacks "--drill omits termination protection" "$RUN" "--disable-api-termination"
has "--drill names the host" "$RUN" "Key=Name,Value=drill-app-"
has "--drill tags BlotDrill" "$RUN" "{Key=BlotDrill,Value=true}"

run "${COMMON[@]}" --ssh-port 2222 --deploy-public-key "$TMP/deploy.pub"
RUN=$(printf '%s\n' "$AWS_LOG" | grep run-instances)
has "--ssh-port adds user data" "$RUN" "--user-data"
has "user data writes the Port line" "$RUN" 'Port 2222\n'
has "user data writes setup.sh's file" "$RUN" "/etc/ssh/sshd_config.d/11-blot-port.conf"
has "user data restarts sshd" "$RUN" "systemctl restart sshd"
has "the ssh wait uses the port" "$SSH_LOG" "-p 2222 "
has "bootstrap gets the port in SSH_OPTS" "$BOOTSTRAP_LOG" "-p 2222 "
has "bootstrap gets BLOT_SSH_PORT" "$BOOTSTRAP_LOG" "BLOT_SSH_PORT=[2222]"
has "bootstrap gets the deploy key" "$BOOTSTRAP_LOG" "BLOT_DEPLOY_PUBLIC_KEY=[ssh-ed25519 AAAAtest test@example.com]"
has "next step names the port" "$OUT" "SSH_PORT=2222"

run --type m6gd.xlarge --key "$TMP/key"
[ "$STATUS" -ne 0 ] && ok "missing --key-name fails" || fail "missing --key-name fails"
run --key-name test-key --key "$TMP/key"
[ "$STATUS" -ne 0 ] && ok "missing --type fails" || fail "missing --type fails"
run --type m6gd.xlarge --key-name test-key --redis-maxmemory 1gb
[ "$STATUS" -ne 0 ] && ok "missing --key fails" || fail "missing --key fails"
run --type m6gd.xlarge --key-name test-key --key "$TMP/key"
[ "$STATUS" -ne 0 ] && ok "missing --redis-maxmemory fails" || fail "missing --redis-maxmemory fails"
lacks "and launches nothing" "$AWS_LOG" "run-instances"
REDIS_MAXMEMORY=2gb run --type m6gd.xlarge --key-name test-key --key "$TMP/key" --deploy-public-key "$TMP/deploy.pub"
has "REDIS_MAXMEMORY in the environment is used" "$BOOTSTRAP_LOG" "REDIS_MAXMEMORY=[2gb]"
run "${COMMON[@]}" --ssh-port 22x
[ "$STATUS" -ne 0 ] && ok "bad --ssh-port fails" || fail "bad --ssh-port fails"
lacks "bad --ssh-port launches nothing" "$AWS_LOG" "run-instances"

# The check that Redis is not reachable from outside: only against a public address.
STUB_ADDRESSES="203.0.113.7 10.0.0.5" STUB_NC_EXIT=1 run "${COMMON[@]}"
[ "$STATUS" -eq 0 ] && ok "a closed port 6379 passes" || fail "a closed port 6379 passes: $OUT"
has "nc checks the public address, port 6379, with a timeout" "$NC_LOG" "-z -w 5 203.0.113.7 6379"
has "launch says it is not reachable" "$OUT" "Port 6379 is not reachable on 203.0.113.7"
has "the next step uses the public address" "$OUT" "PUBLIC_IP=203.0.113.7"
STUB_ADDRESSES="203.0.113.7 10.0.0.5" STUB_NC_EXIT=0 run "${COMMON[@]}"
[ "$STATUS" -ne 0 ] && ok "an open port 6379 fails" || fail "an open port 6379 fails"
has "and says Redis is exposed" "$OUT" "REDIS IS EXPOSED"
has "and that the instance is still running" "$OUT" "i-test is still running"
lacks "and does not report success" "$OUT" "Done:"
STUB_ADDRESSES="None 10.0.0.5" STUB_NC_EXIT=0 run "${COMMON[@]}"
[ "$STATUS" -eq 0 ] && ok "without a public address nothing is checked" || fail "without a public address nothing is checked: $OUT"
[ -z "$NC_LOG" ] && ok "and nc is not run" || fail "and nc is not run"
has "and launch says so" "$OUT" "port 6379 was not checked"

# Finding the deploy key: flag, then environment, then ~/.ssh/blot-deploy.pub, then gh.
NOKEY=(--type m6gd.xlarge --key-name test-key --key "$TMP/key" --redis-maxmemory 1gb)
echo "ssh-ed25519 AAAAflag" > "$TMP/flag.pub"
echo "ssh-ed25519 AAAAfile" > "$HOME/.ssh/blot-deploy.pub"
BLOT_DEPLOY_PUBLIC_KEY="ssh-ed25519 AAAAenv" STUB_GH_KEY="ssh-ed25519 AAAAgh" run "${NOKEY[@]}" --deploy-public-key "$TMP/flag.pub"
has "the flag beats the others" "$BOOTSTRAP_LOG" "BLOT_DEPLOY_PUBLIC_KEY=[ssh-ed25519 AAAAflag]"
has "and the source is printed" "$OUT" "Deploy public key: --deploy-public-key"
BLOT_DEPLOY_PUBLIC_KEY="ssh-ed25519 AAAAenv" STUB_GH_KEY="ssh-ed25519 AAAAgh" run "${NOKEY[@]}"
has "the environment beats the file and gh" "$BOOTSTRAP_LOG" "BLOT_DEPLOY_PUBLIC_KEY=[ssh-ed25519 AAAAenv]"
STUB_GH_KEY="ssh-ed25519 AAAAgh" run "${NOKEY[@]}"
has "the file beats gh" "$BOOTSTRAP_LOG" "BLOT_DEPLOY_PUBLIC_KEY=[ssh-ed25519 AAAAfile]"
has "and the source is printed" "$OUT" "Deploy public key: ~/.ssh/blot-deploy.pub"
lacks "the key itself is not printed" "$OUT" "AAAAfile"
[ ! -e "$TMP/gh.log" ] && ok "gh is not asked when the file has the key" || fail "gh is not asked when the file has the key"
rm "$HOME/.ssh/blot-deploy.pub"
STUB_GH_KEY="ssh-ed25519 AAAAgh" run "${NOKEY[@]}"
has "gh is the last resort" "$BOOTSTRAP_LOG" "BLOT_DEPLOY_PUBLIC_KEY=[ssh-ed25519 AAAAgh]"
has "gh is asked for the deploy environment variable" "$(cat "$TMP/gh.log")" "variable get BLOT_DEPLOY_PUBLIC_KEY --env deploy --repo blotcms/blot"
has "and the source is printed" "$OUT" "Deploy public key: the GitHub deploy environment"
lacks "the gh key is not printed" "$OUT" "AAAAgh"
run "${NOKEY[@]}"
[ "$STATUS" -ne 0 ] && ok "gh failing with nothing else fails on a real host" || fail "gh failing with nothing else fails on a real host"
has "and says what to do" "$OUT" "no deploy public key"
lacks "and launches nothing" "$AWS_LOG" "run-instances"
run "${NOKEY[@]}" --drill
[ "$STATUS" -eq 0 ] && ok "--drill goes on without a key" || fail "--drill goes on without a key: $OUT"
has "and bootstrap gets an empty key" "$BOOTSTRAP_LOG" "BLOT_DEPLOY_PUBLIC_KEY=[]"
STUB_GH_KEY="ssh-ed25519 AAAAgh" run --dry-run --type m6gd.xlarge --key-name test-key
[ "$STATUS" -eq 0 ] && ok "--dry-run goes on without a key" || fail "--dry-run goes on without a key: $OUT"
[ ! -e "$TMP/gh.log" ] && ok "and does not ask gh" || fail "and does not ask gh"
STUB_GH_KEY="not a key" run "${NOKEY[@]}"
[ "$STATUS" -ne 0 ] && ok "a malformed key fails" || fail "a malformed key fails"
lacks "and launches nothing" "$AWS_LOG" "run-instances"
lacks "and the value is not printed" "$OUT" "not a key"
STUB_GH_KEY=$'ssh-ed25519 AAAA1\nssh-ed25519 AAAA2' run "${NOKEY[@]}"
[ "$STATUS" -ne 0 ] && ok "a two-line key fails" || fail "a two-line key fails"
BLOT_DEPLOY_PUBLIC_KEY="ecdsa-sha2-nistp256 AAAAec" run "${NOKEY[@]}"
[ "$STATUS" -eq 0 ] && ok "an ecdsa key passes" || fail "an ecdsa key passes: $OUT"

run --list
has "--list filters on the provisioning tag" "$AWS_LOG" "tag:HostProvisionedBy,Values=config/host/launch.sh"

[ "$FAILED" -eq 0 ] && echo "all passed" || { echo "some tests FAILED"; exit 1; }
