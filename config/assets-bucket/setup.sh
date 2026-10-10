#!/usr/bin/env bash
# Creates the S3 bucket for generated per-blog assets and the IAM user the app
# uses to read and write it. Safe to run again: each step checks or replaces
# what it sets. See README.md in this directory.
#
#   AWS_PROFILE=<profile> AWS_REGION=<region> ./setup.sh [--dry-run] <bucket>
#
# Uses whatever profile and credentials the aws CLI finds. With --dry-run it
# prints each change it would make and makes none (and doesn't check what
# already exists, so it prints the create steps too).
#
# The bucket is created in us-west-2, whatever AWS_REGION says: the app hosts
# are there. The IAM user's name can be changed with IAM_USER.
set -euo pipefail

BUCKET_REGION="us-west-2"
IAM_USER="${IAM_USER:-blot-assets-app}"
POLICY_NAME="blot-assets-bucket-access"

DRY_RUN=false
BUCKET=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    -*) echo "Unknown option $arg" >&2; exit 2 ;;
    *)
      if [ -n "$BUCKET" ]; then echo "Only one bucket name, please" >&2; exit 2; fi
      BUCKET="$arg"
      ;;
  esac
done

if [ -z "$BUCKET" ]; then
  echo "Usage: $0 [--dry-run] <bucket>" >&2
  exit 2
fi

if ! [[ "$BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; then
  echo "'$BUCKET' isn't a valid bucket name" >&2
  exit 2
fi

# Anyone may download an object whose key starts with blog_ (a blog's
# assets: {blogID}/{path}). Nothing else is public: no listing, no writes.
BUCKET_POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadBlogAssets",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${BUCKET}/blog_*"
    }
  ]
}
JSON
)

# What the app needs: read, write and delete objects, and list the bucket
# (the backfill script compares against it; removing a directory lists it)
USER_POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ObjectAccess",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    },
    {
      "Sid": "ListBucket",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::${BUCKET}"
    }
  ]
}
JSON
)

# Runs a command, or just prints it with --dry-run
run() {
  if $DRY_RUN; then
    echo "+ $*"
  else
    "$@"
  fi
}

step() {
  echo
  echo "== $*"
}

if $DRY_RUN; then
  echo "Dry run: nothing will be changed."
fi

step "Bucket $BUCKET in $BUCKET_REGION"

if ! $DRY_RUN && aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "Already exists"
else
  $DRY_RUN && echo "(only if it doesn't exist yet)"
  run aws s3api create-bucket \
    --bucket "$BUCKET" \
    --region "$BUCKET_REGION" \
    --create-bucket-configuration "LocationConstraint=$BUCKET_REGION"
fi

step "Ownership: bucket owner enforced (no ACLs)"
run aws s3api put-bucket-ownership-controls \
  --bucket "$BUCKET" \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'

echo
echo "Versioning: left off"

step "Public access: ACLs blocked, a public bucket policy allowed"
run aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
  'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false'

step "Bucket policy: public s3:GetObject on blog_* only"
run aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$BUCKET_POLICY"

step "IAM user $IAM_USER"

if ! $DRY_RUN && aws iam get-user --user-name "$IAM_USER" >/dev/null 2>&1; then
  echo "Already exists"
else
  $DRY_RUN && echo "(only if it doesn't exist yet)"
  run aws iam create-user --user-name "$IAM_USER"
fi

run aws iam put-user-policy \
  --user-name "$IAM_USER" \
  --policy-name "$POLICY_NAME" \
  --policy-document "$USER_POLICY"

step "Access key"
cat <<TEXT
This script doesn't create an access key, so no secret is printed or stored.
To make one, run:

  aws iam create-access-key --user-name $IAM_USER

and put AccessKeyId and SecretAccessKey in the app host's environment file as
BLOT_AWS_KEY and BLOT_AWS_SECRET (see README.md). A user may have two keys, so
a new one can be created before the old one is deleted:

  aws iam list-access-keys --user-name $IAM_USER
  aws iam delete-access-key --user-name $IAM_USER --access-key-id <old key id>
TEXT
