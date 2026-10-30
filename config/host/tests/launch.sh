#!/bin/bash
# Tests config/host/launch.sh with a stub aws, a stub ssh and a stub bootstrap.sh
# that record their arguments: no Docker, no AWS, no ssh. The stubs are on PATH
# (aws, ssh) and next to a copy of launch.sh (bootstrap.sh).
#
# Usage: config/host/tests/launch.sh   (also run it with /bin/bash on a Mac: 3.2)
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FAILED=0

ok() { echo "ok - $*"; }
fail() { echo "FAILED - $*"; FAILED=1; }

mkdir "$TMP/bin" "$TMP/host"
cp "$REPO/config/host/launch.sh" "$TMP/host/launch.sh"
touch "$TMP/key"
echo "ssh-ed25519 AAAAtest test@example.com" > "$TMP/deploy.pub"

# Each stub appends one line per call to its log (arguments joined by spaces).
cat > "$TMP/bin/aws" << 'EOF'
#!/bin/bash
a="$*"; echo "${a//$'\n'/\\n}" >> "$STUB_DIR/aws.log"
case "$*" in
  *"ssm get-parameter"*) echo ami-test ;;
  *"describe-images"*) echo /dev/xvda ;;
  *"run-instances"*) echo i-test ;;
  *"describe-instances --instance-ids"*) echo "None 10.0.0.5" ;;
esac
EOF
cat > "$TMP/bin/ssh" << 'EOF'
#!/bin/bash
echo "$*" >> "$STUB_DIR/ssh.log"
EOF
cat > "$TMP/host/bootstrap.sh" << 'EOF'
#!/bin/bash
echo "$* SSH_OPTS=[$SSH_OPTS] BLOT_SSH_PORT=[$BLOT_SSH_PORT] BLOT_DEPLOY_PUBLIC_KEY=[$BLOT_DEPLOY_PUBLIC_KEY]" >> "$STUB_DIR/bootstrap.log"
EOF
chmod +x "$TMP/bin/aws" "$TMP/bin/ssh" "$TMP/host/bootstrap.sh" "$TMP/host/launch.sh"

# run <args...>: launch.sh with the stubs; sets OUT, STATUS and the logs.
run() {
  rm -f "$TMP"/*.log
  STATUS=0
  OUT=$(STUB_DIR="$TMP" PATH="$TMP/bin:$PATH" "$TMP/host/launch.sh" "$@" 2>&1) || STATUS=$?
  AWS_LOG=$(cat "$TMP/aws.log" 2> /dev/null || true)
  SSH_LOG=$(cat "$TMP/ssh.log" 2> /dev/null || true)
  BOOTSTRAP_LOG=$(cat "$TMP/bootstrap.log" 2> /dev/null || true)
}
# has <description> <text> <pattern>
has() { if printf '%s\n' "$2" | grep -qF -- "$3"; then ok "$1"; else fail "$1 (no '$3' in: $2)"; fi; }
lacks() { if printf '%s\n' "$2" | grep -qF -- "$3"; then fail "$1 (found '$3')"; else ok "$1"; fi; }

COMMON=(--type m6gd.xlarge --key-name test-key --key "$TMP/key")

run --dry-run --type m6gd.xlarge --key-name test-key
[ "$STATUS" -eq 0 ] && ok "dry run exits 0 without --key" || fail "dry run exits 0 without --key: $OUT"
lacks "dry run does not call run-instances" "$AWS_LOG" "run-instances"
has "dry run prints the command" "$OUT" "would run: aws"

run "${COMMON[@]}"
[ "$STATUS" -eq 0 ] || fail "normal launch exits 0: $OUT"
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
has "launch prints the next step" "$OUT" "npm run deploy-host"
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
run --type m6gd.xlarge --key-name test-key
[ "$STATUS" -ne 0 ] && ok "missing --key fails" || fail "missing --key fails"
run "${COMMON[@]}" --ssh-port 22x
[ "$STATUS" -ne 0 ] && ok "bad --ssh-port fails" || fail "bad --ssh-port fails"
lacks "bad --ssh-port launches nothing" "$AWS_LOG" "run-instances"

run --list
has "--list filters on the provisioning tag" "$AWS_LOG" "tag:HostProvisionedBy,Values=config/host/launch.sh"

[ "$FAILED" -eq 0 ] && echo "all passed" || { echo "some tests FAILED"; exit 1; }
