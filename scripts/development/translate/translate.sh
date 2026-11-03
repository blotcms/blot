#!/usr/bin/env bash
set -euo pipefail

# Translate an existing website's design into a Blot template.
#
# Usage: npm run translate <url>
#
# This script does not acquire content. Provision a site, scaffold a template,
# then wait for the operator to move content into the folder. See RESEARCH.md.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../../../" && pwd)"
CONTAINER="${BLOT_CONTAINER:-blot-node-app-1}"

usage() {
  cat <<EOF
Usage: npm run translate <url>

Builds a Blot template reproducing the design of <url>.

Requires the development server to already be running:

  npm start

Content is not fetched by this script. After the site is scaffolded you will be
asked to move content into its folder — see scripts/development/dynamic-importer
or Blot's dashboard importers.
EOF
}

die() {
  echo "" >&2
  echo "[translate] $1" >&2
  if [ $# -gt 1 ]; then
    echo "" >&2
    echo "$2" >&2
  fi
  echo "" >&2
  exit 1
}

# ---------------------------------------------------------------- arguments

if [ $# -eq 0 ]; then
  usage
  exit 1
fi

URL="$1"
shift || true

for arg in "$@"; do
  die "Unknown option: $arg" "Usage: npm run translate <url>"
done

case "$URL" in
  -h|--help|help)
    usage
    exit 0
    ;;
  http://*|https://*)
    ;;
  *)
    die "Not a URL: '$URL'" "Pass a full URL, e.g. npm run translate https://example.com"
    ;;
esac

# Read a line from the terminal even when stdin is a pipe. Returns non-zero when
# there is no terminal at all, so callers can fail loudly instead of blocking
# forever on a read that will never be answered.
# Exit status: 0 read a line (possibly empty), 1 no terminal at all,
# 2 end of input. Distinguishing 2 matters — swallowing it would spin this
# loop forever against a closed stdin.
ask() {
  local reply=""
  if [ -t 0 ]; then
    read -r reply || return 2
  elif [ -r /dev/tty ] && exec 3</dev/tty 2>/dev/null; then
    if ! read -r reply <&3; then
      exec 3<&-
      return 2
    fi
    exec 3<&-
  else
    return 1
  fi
  echo "$reply"
}

require_tty() {
  if [ ! -t 0 ] && { [ ! -r /dev/tty ] || ! (exec 3</dev/tty) 2>/dev/null; }; then
    die "This step needs a terminal to prompt for input." \
"Run it directly rather than through a pipe or a non-interactive shell:

  npm run translate $URL
${FOLDER:+
Nothing is lost — the site is already provisioned and will be reused. Its
folder is:

  $FOLDER}"
  fi
}


# ---------------------------------------------------------------- preflight

# The development stack is long-lived and interactive (it tails logs and traps
# signals to tear down compose), so we never start it here — we require it.
NOT_RUNNING="Start it in another window, then run this again:

  npm start"

echo "[translate] Checking the development server"

if ! command -v docker >/dev/null 2>&1; then
  die "docker is not installed or not on PATH."
fi

if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
  die "The development server is not running (no '$CONTAINER' container)." "$NOT_RUNNING"
fi

# Read the effective host from inside the container rather than guessing. The
# defaults disagree: start.sh sets BLOT_HOST=local.blot, while config/index.js
# falls back to "localhost" when the variable is absent.
if ! BLOT_HOST="$(docker exec "$CONTAINER" node -e 'process.stdout.write(require("config").host)' 2>/dev/null)"; then
  die "Could not read the server's configuration." "$NOT_RUNNING"
fi

if [ -z "$BLOT_HOST" ]; then
  die "The server reported an empty host." "$NOT_RUNNING"
fi

# --insecure on purpose: the mkcert certificate is only trusted on machines where
# `mkcert -install` has run. An untrusted certificate is not the same failure as
# a server being down, and shouldn't produce a misleading error.
HEALTH_URL="https://$BLOT_HOST/health"
HEALTHY=false

for attempt in 1 2 3; do
  if curl -sk --max-time 5 -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null | grep -q '^200$'; then
    HEALTHY=true
    break
  fi
  # The container can be up while the app is still booting or mid nodemon restart.
  [ "$attempt" -lt 3 ] && sleep 2
done

if [ "$HEALTHY" != true ]; then
  die "The server is not responding at $HEALTH_URL" "The '$CONTAINER' container is running but not serving yet.
If it has only just started, wait a moment and try again. Otherwise:

  npm start"
fi

echo "[translate] Server is up at https://$BLOT_HOST"

# The agent is not run by this script — it prints the command for you to run in
# another window. Check it exists anyway, so a missing CLI is reported before a
# site is provisioned rather than at the very end.
MODEL="${TRANSLATE_MODEL:-sonnet}"

if ! command -v claude >/dev/null 2>&1; then
  die "The claude CLI is not installed or not on PATH." \
"It runs on the host, not in the container:

  https://claude.com/claude-code"
fi

# ---------------------------------------------------------------- provision

HANDLE="$(node "$DIR/handle.js" "$URL")"

if [ -z "$HANDLE" ]; then
  die "Could not derive a site handle from '$URL'."
fi

echo "[translate] Handle: $HANDLE"

# index.js prints key=value lines on stdout and progress on stderr.
PROVISION_OUTPUT="$(docker exec "$CONTAINER" node scripts/development/translate "$URL" "$HANDLE")"

# Pull a key=value field out of a script's output. Must tolerate a missing key:
# grep exits 1 when it matches nothing, and with `set -o pipefail` that would
# otherwise abort the whole script mid-pipeline.
extract() {
  local key="$1"
  local text="$2"
  echo "$text" | grep "^$key=" | head -n1 | cut -d= -f2- || true
}

field() {
  extract "$1" "$PROVISION_OUTPUT"
}

BLOG_ID="$(field blogID)"
HANDLE="$(field handle)"
SITE_URL="$(field siteURL)"
PREVIEW_URL="$(field previewURL)"
DASHBOARD_URL="$(field dashboardURL)"
TEMPLATE_SLUG="$(field templateSlug)"

if [ -z "$BLOG_ID" ]; then
  die "Provisioning did not report a blog ID." "$PROVISION_OUTPUT"
fi

# The container reports its own path; the operator needs the host equivalent.
FOLDER="$ROOT/data/local-sources/$HANDLE"

echo "[translate] Site:     $SITE_URL"
echo "[translate] Template: $TEMPLATE_SLUG"

# ------------------------------------------------------------- content gate

content_summary() {
  docker exec "$CONTAINER" \
    node scripts/development/translate/content-check "$BLOG_ID" 2>/dev/null || true
}

print_content_routes() {
  cat <<EOF

This script does not fetch content. Move the site's content into:

  $FOLDER

Ways to get it there:

  * WordPress, Squarespace, Blogger or Are.na
      Use Blot's dashboard importer, then unzip the result into the folder.
      $DASHBOARD_URL

  * Any other live site
      npm run dynamic-importer $URL

  * Anything else
      Copy files in by hand, or try one of the demo folders in
      app/templates/folders/ to exercise the template loop.

Posts need a 'Date:' line in their metadata or a dated path (2024/03-12-name.txt)
for dates to be meaningful — Blot does not read the file's modified time.

EOF
}

# Content may already be present from an earlier run, or dropped in while this
# script was provisioning. Either way the watcher may not have seen it.
echo "[translate] Reading the folder"
# Let the watcher drain first: it takes the same folder lock for every event, and
# a directory of content can keep it busy longer than sync is willing to retry.
docker exec "$CONTAINER" \
  node scripts/development/translate/settle "$BLOG_ID" >/dev/null 2>&1 || true
docker exec "$CONTAINER" \
  node scripts/development/translate/rescan "$BLOG_ID" >/dev/null 2>&1 || true

CONTENT_OK=false

while [ "$CONTENT_OK" != true ]; do
  SUMMARY_OUTPUT="$(content_summary)"
  PUBLISHABLE="$(extract publishable "$SUMMARY_OUTPUT")"

  if [ "${PUBLISHABLE:-0}" -gt 0 ] 2>/dev/null; then
    CONTENT_OK=true
    break
  fi

  print_content_routes
  require_tty
  printf "Press enter once the content is in place (or q to quit): "

  if ! REPLY_TEXT="$(ask)"; then
    die "No more input — stopping rather than looping." \
"The site is provisioned and will be reused if you run this again. Its folder is:

  $FOLDER"
  fi

  case "$REPLY_TEXT" in
    q|Q|quit|exit)
      die "Stopped. The site is provisioned and will be reused if you run this again."
      ;;
  esac

  # Read the folder explicitly rather than waiting on the watcher. Content copied
  # in before the watcher started listening is invisible to it: chokidar runs with
  # ignoreInitial, and setup only begins after sync/fix finishes.
  echo "[translate] Reading the folder"
  docker exec "$CONTAINER" \
    node scripts/development/translate/settle "$BLOG_ID" >/dev/null 2>&1 || true
  docker exec "$CONTAINER" \
    node scripts/development/translate/rescan "$BLOG_ID" >/dev/null 2>&1 || true
  docker exec "$CONTAINER" \
    node scripts/development/translate/settle "$BLOG_ID" >/dev/null 2>&1 || true

  SUMMARY_OUTPUT="$(content_summary)"
  PUBLISHABLE="$(extract publishable "$SUMMARY_OUTPUT")"

  if [ "${PUBLISHABLE:-0}" -gt 0 ] 2>/dev/null; then
    CONTENT_OK=true
  else
    echo ""
    echo "[translate] Still nothing published from that folder."
    echo "[translate] Blot ignores files it cannot convert, anything starting with"
    echo "[translate] an underscore or a dot, and the Templates directory."
  fi
done

SUMMARY="$(extract summary "$SUMMARY_OUTPUT")"
WARNING="$(extract warning "$SUMMARY_OUTPUT")"

echo "[translate] Content: $SUMMARY"

if [ -n "$WARNING" ]; then
  echo ""
  echo "[translate] Note: $WARNING"
  echo ""
fi

# Commit whatever has changed since the last run: content the operator supplied,
# and anything the agent edited in between. Keeping each round as its own commit
# is what makes the agent's work reviewable, and a bad round a revert.
if [ -d "$FOLDER/.git" ]; then
  git -C "$FOLDER" add -A >/dev/null 2>&1 || true

  if ! git -C "$FOLDER" diff --cached --quiet 2>/dev/null; then
    # One commit beyond the scaffold means this is the first content to arrive.
    if [ "$(git -C "$FOLDER" rev-list --count HEAD 2>/dev/null || echo 1)" -le 1 ]; then
      COMMIT_MESSAGE="Add content as supplied"
    else
      COMMIT_MESSAGE="Changes since last run"
    fi

    git -C "$FOLDER" \
      -c user.name=translate -c user.email=translate@local \
      commit --quiet -m "$COMMIT_MESSAGE" >/dev/null 2>&1 || true
    echo "[translate] Committed: $COMMIT_MESSAGE"
  fi
fi

# --------------------------------------------------------------- screenshots

VERIFICATION="$FOLDER/.verification"
TARGETS_FILE="$VERIFICATION/targets.json"

mkdir -p "$VERIFICATION"

# Settle before shooting, not after: .verification/ is not ignored by the folder
# watcher, so writing screenshots bumps cacheID too. Shooting first would leave
# the two chasing each other.
echo "[translate] Waiting for the site to finish rebuilding"
docker exec "$CONTAINER" \
  node scripts/development/translate/settle "$BLOG_ID" >/dev/null 2>&1 || true

echo "[translate] Working out which pages to compare"
if ! docker exec "$CONTAINER" \
  node scripts/development/translate/targets "$BLOG_ID" "$URL" > "$TARGETS_FILE" 2>/dev/null; then
  die "Could not work out which pages to screenshot."
fi

# Screenshots run on the host: the container resolves *.local.blot to itself and
# cannot reach the site (verified — connection refused).
echo "[translate] Taking screenshots"
CAPTURE_OUTPUT="$(node "$DIR/capture.js" "$TARGETS_FILE" "$VERIFICATION" 2>&1 || true)"

echo "$CAPTURE_OUTPUT" | grep '^captured=' | sed 's/^captured=/[translate]   captured /' || true

CAPTURE_FAILURES="$(echo "$CAPTURE_OUTPUT" | grep '^failed=' || true)"

if [ -n "$CAPTURE_FAILURES" ]; then
  echo ""
  echo "$CAPTURE_FAILURES" | sed 's/^failed=/[translate]   could not capture /'
  echo "[translate]   (source pages are captured on a best guess of the original"
  echo "[translate]   URL, so a miss here is normal unless permalinks were kept)"
fi

# ----------------------------------------------------------- comparison UI

COMPARE_PORT="${TRANSLATE_COMPARE_PORT:-3021}"
COMPARE_PID=""
COMPARE_URL=""

stop_compare() {
  if [ -n "$COMPARE_PID" ] && kill -0 "$COMPARE_PID" 2>/dev/null; then
    kill "$COMPARE_PID" 2>/dev/null || true
    wait "$COMPARE_PID" 2>/dev/null || true
  fi
}

trap stop_compare EXIT INT TERM

node "$DIR/compare-server.js" "$VERIFICATION" "$COMPARE_PORT" \
  > "$VERIFICATION/compare.log" 2>&1 &
COMPARE_PID=$!

sleep 1

if kill -0 "$COMPARE_PID" 2>/dev/null; then
  COMPARE_URL="http://localhost:$COMPARE_PORT"
  echo "[translate] Comparison UI at $COMPARE_URL"
  command -v open >/dev/null 2>&1 && open "$COMPARE_URL" >/dev/null 2>&1 || true
else
  COMPARE_PID=""
  echo "[translate] Could not start the comparison UI:"
  sed 's/^/[translate]   /' "$VERIFICATION/compare.log" 2>/dev/null || true
fi

echo ""
echo "[translate] Ready."
echo "[translate]   Folder:    $FOLDER"
echo "[translate]   Site:      $SITE_URL"
echo "[translate]   Preview:   $PREVIEW_URL"
echo "[translate]   Dashboard: $DASHBOARD_URL"
echo "[translate]   Shots:     $VERIFICATION"
[ -n "$COMPARE_URL" ] && echo "[translate]   Compare:   $COMPARE_URL"

# ------------------------------------------------------------------ handover

BRIEF_FILE="$VERIFICATION/brief.md"
FEEDBACK_FILE="$VERIFICATION/feedback.txt"

# Compose the brief plus this run's specifics. Written to a file rather than
# passed inline because it runs to a couple of hundred lines.
{
  if [ -s "$FEEDBACK_FILE" ]; then
    cat <<EOF
## Feedback on the last attempt

$(cat "$FEEDBACK_FILE")

Address this first, then continue with the brief below.

---

EOF
  fi

  cat "$DIR/prompt.md"

  cat <<EOF

---

## This run

- Target design: $URL
- Site folder: $FOLDER (you are in it)
- Template directory: Templates/$TEMPLATE_SLUG
- Content in the folder: $SUMMARY
- Screenshots: .verification/input-*.png (target) and output-*.png (yours)
- Preview the result at: $PREVIEW_URL
- Inspect render data by appending ?json=true to any page on that preview

Build the template now.
EOF
} > "$BRIEF_FILE"

# Consumed — clear it so the same feedback is not replayed on the next run.
rm -f "$FEEDBACK_FILE"

echo ""
echo "──────────────────────────────────────────────────────────────────────"
echo ""
echo "  Run this in another window to build the template:"
echo ""
echo "    cd $FOLDER && claude --model $MODEL \"\$(cat .verification/brief.md)\""
echo ""
echo "  Then come back and re-run this script to see the result:"
echo ""
echo "    npm run translate $URL"
echo ""
echo "──────────────────────────────────────────────────────────────────────"
echo ""

# --------------------------------------------------------------------- done

echo ""
echo "[translate] Ready."
echo "[translate]   Folder:     $FOLDER"
echo "[translate]   Preview:    $PREVIEW_URL"
echo "[translate]   Brief:      $BRIEF_FILE"
[ -n "$COMPARE_URL" ] && echo "[translate]   Compare:    $COMPARE_URL"
echo ""
echo "Re-running is the loop: it re-reads the folder, commits whatever the agent"
echo "changed, takes fresh screenshots and rebuilds the comparison. Feedback typed"
echo "into the comparison UI is folded into the next brief."
echo ""

if [ -n "$COMPARE_URL" ]; then
  printf "Press enter to stop the comparison server and exit: "
  ask >/dev/null || true
fi
