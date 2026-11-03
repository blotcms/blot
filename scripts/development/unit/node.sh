#!/bin/sh
#
# node-a in local development: the unit supervisor runs this as ec2-user
# (UNIT_NODE_COMMAND, set by start.sh), and nodemon restarts Node when app/
# changes. node-b, which node-a forks, inherits NODE_OPTIONS.
export NODE_OPTIONS="--max-old-space-size=${BLOT_MAX_OLD_SPACE_SIZE:-750} --trace-deprecation --require /usr/src/app/scripts/development/fake-dropbox-errors.js --require /usr/src/app/scripts/development/fake-google-drive-errors.js"

exec nodemon /usr/src/app/app/index.js --watch /usr/src/app/app -e js,html,css \
  --ignore /usr/src/app/app/documentation/data \
  --ignore /usr/src/app/app/documentation/output \
  --ignore /usr/src/app/app/views \
  --ignore /usr/src/app/app/views-built \
  --ignore '/usr/src/app/app/clients/*/views' \
  --ignore /usr/src/app/app/templates/folders \
  --ignore /usr/src/app/app/templates/source \
  --ignore '**/tests/**'
