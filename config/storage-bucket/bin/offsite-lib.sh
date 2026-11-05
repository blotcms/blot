# Sourced by offsite-sync.sh and offsite-restore-test.sh, not run. Sets up two
# rclone remotes from environment variables, so no rclone.conf with a key in it
# is ever written:
#
#   storage:  the S3 storage bucket, read with the app's key (BLOT_AWS_KEY and
#             BLOT_AWS_SECRET in /etc/blot/secrets.env). The host has no
#             instance profile, and the [default] profile in ~/.aws is for the
#             Redis backups. Neither script ever writes or deletes through it.
#   offsite:  Backblaze B2 through rclone's native B2 backend, with the key of
#             the blot-b2-storage profile in ~ec2-user/.aws. That key has no
#             deleteFiles, so a file deleted at the source is hidden in B2
#             (b2_hide_file) and its versions are kept until the bucket's
#             lifecycle rule removes them, 30 days later.
#
# It sets STORAGE_BUCKET and OFFSITE_BUCKET, and OFFSITE_ROOT, the copy's
# prefix in B2 (offsite:<bucket>/storage). Never prints a key.
#
# Written to run under sh as well as bash, for the tests. BLOT_ROOT prefixes
# the paths, for the tests.

ROOT=${BLOT_ROOT:-}
SECRETS_FILE=$ROOT/etc/blot/secrets.env
# One line, the B2 bucket's name (not in the repo). No file means off.
OFFSITE_BUCKET_FILE=$ROOT/etc/blot/storage-offsite-bucket
OFFSITE_PROFILE=${BLOT_STORAGE_OFFSITE_PROFILE:-blot-b2-storage}
# The Redis key for the last successful sync, read by the daily email and
# app/scheduler/check-redis-host.js: "<iso time> <objects> <bytes>".
OFFSITE_REDIS_KEY=blot:storage:offsite

# The bucket named in the bucket file, without an s3:// or b2:// prefix, or
# nothing.
offsite_bucket() {
  head -n 1 "$OFFSITE_BUCKET_FILE" 2> /dev/null | tr -d '[:space:]' | sed 's|^[a-z0-9]*://||; s|/*$||'
}

# env_value <name>: the last value of <name> in secrets.env, which is a docker
# --env-file (KEY=value lines, optionally after export; quotes are part of the
# value). Read, never sourced.
env_value() {
  sed -n "s/^\(export \)\{0,1\}$1=//p" "$SECRETS_FILE" 2> /dev/null | tail -n 1 | tr -d '\r'
}

# setup_remotes: exports the remotes' settings. Returns non-zero, saying what is
# missing, if it can't. Only call it once the bucket file names a bucket.
setup_remotes() {
  OFFSITE_BUCKET=$(offsite_bucket)
  [ -n "$OFFSITE_BUCKET" ] || { echo "no bucket in $OFFSITE_BUCKET_FILE"; return 1; }
  OFFSITE_ROOT=offsite:$OFFSITE_BUCKET/storage

  [ -r "$SECRETS_FILE" ] || { echo "cannot read $SECRETS_FILE"; return 1; }
  STORAGE_BUCKET=$(env_value BLOT_STORAGE_BUCKET)
  storage_region=$(env_value BLOT_STORAGE_REGION)
  storage_key_id=$(env_value BLOT_AWS_KEY)
  storage_secret=$(env_value BLOT_AWS_SECRET)
  [ -n "$STORAGE_BUCKET" ] || { echo "no BLOT_STORAGE_BUCKET in $SECRETS_FILE"; return 1; }
  [ -n "$storage_key_id" ] && [ -n "$storage_secret" ] ||
    { echo "no BLOT_AWS_KEY or BLOT_AWS_SECRET in $SECRETS_FILE"; return 1; }

  b2_key_id=$(aws configure get aws_access_key_id --profile "$OFFSITE_PROFILE" 2> /dev/null) || b2_key_id=
  b2_key=$(aws configure get aws_secret_access_key --profile "$OFFSITE_PROFILE" 2> /dev/null) || b2_key=
  [ -n "$b2_key_id" ] && [ -n "$b2_key" ] ||
    { echo "no $OFFSITE_PROFILE profile with a key in ~/.aws/credentials"; return 1; }

  # No config file at all: everything is in the environment.
  export RCLONE_CONFIG=/dev/null
  export RCLONE_CONFIG_STORAGE_TYPE=s3
  export RCLONE_CONFIG_STORAGE_PROVIDER=AWS
  export RCLONE_CONFIG_STORAGE_ENV_AUTH=false
  export RCLONE_CONFIG_STORAGE_REGION="${storage_region:-us-west-2}"
  export RCLONE_CONFIG_STORAGE_ACCESS_KEY_ID="$storage_key_id"
  export RCLONE_CONFIG_STORAGE_SECRET_ACCESS_KEY="$storage_secret"
  export RCLONE_CONFIG_OFFSITE_TYPE=b2
  export RCLONE_CONFIG_OFFSITE_ACCOUNT="$b2_key_id"
  export RCLONE_CONFIG_OFFSITE_KEY="$b2_key"
  # Hide, never delete: the key could not delete anyway (401), and the old
  # versions are the point of the copy.
  export RCLONE_CONFIG_OFFSITE_HARD_DELETE=false
  unset storage_key_id storage_secret b2_key_id b2_key
}
