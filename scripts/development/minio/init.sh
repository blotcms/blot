#!/bin/sh
# Creates the development assets bucket in MinIO and allows anonymous
# downloads of blog_* keys only, as the production bucket does (see
# config/assets-bucket/setup.sh): public s3:GetObject on blog_*, no listing,
# no public writes. Safe to run again. Run by the minio-init service in
# docker-compose.yml, which provides the endpoint and credentials.
set -eu

BUCKET="${BLOT_ASSETS_BUCKET:-blot-assets-dev}"

if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "Bucket $BUCKET exists"
else
  aws s3api create-bucket --bucket "$BUCKET"
  echo "Created bucket $BUCKET"
fi

aws s3api put-bucket-policy --bucket "$BUCKET" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {
      \"Sid\": \"PublicReadBlogAssets\",
      \"Effect\": \"Allow\",
      \"Principal\": \"*\",
      \"Action\": \"s3:GetObject\",
      \"Resource\": \"arn:aws:s3:::$BUCKET/blog_*\"
    }
  ]
}"

echo "Anonymous downloads of blog_* allowed on $BUCKET"
