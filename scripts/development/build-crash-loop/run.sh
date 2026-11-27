#!/bin/sh
# Runs spike.js in a throwaway container on the local stack's network, with
# this checkout's code and the stack's Redis, bucket and data directory.
# Needs `npm start` running. Arguments go to spike.js.
#
#   OLD=1 scripts/development/build-crash-loop/run.sh --paragraphs 1800 --edit
#
# OLD=1 mounts the .docx converter from before #2988, whose quadratic title
# check blocks the event loop on a long file, over the current one.
set -e
W=$(git rev-parse --show-toplevel)
M=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
MOUNT=""
if [ "$OLD" = 1 ]; then
  mkdir -p "$W/data"
  git -C "$W" show c300a7ed6^:app/build/converters/docx/index.js >"$W/data/build-crash-loop-docx.js"
  MOUNT="-v $W/data/build-crash-loop-docx.js:/usr/src/app/app/build/converters/docx/index.js:ro"
fi
exec docker run --rm --name blot-build-crash-loop --network blot_default \
  --env-file "$M/.env" -e BLOT_REDIS_HOST=redis -e BLOT_PREVIEW=true \
  -e BLOT_STORAGE_BUCKET=blot-storage-dev -e BLOT_STORAGE_ENDPOINT=http://minio:9000 \
  -e BLOT_AWS_KEY=blot-dev -e BLOT_AWS_SECRET=blot-dev-secret \
  -v "$M/data:/usr/src/app/data" -v "$W/app:/usr/src/app/app" \
  -v "$W/scripts:/usr/src/app/scripts" -v "$W/config:/usr/src/app/config" \
  $MOUNT --entrypoint node blot scripts/development/build-crash-loop/spike.js "$@"
