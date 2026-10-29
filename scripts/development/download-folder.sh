#!/usr/bin/env bash
set -euo pipefail

read -p 'Enter blog identifier: ' BLOGID && ssh blot "docker exec blot-blue node /usr/src/app/scripts/info \"$BLOGID\"" | grep 'blog_' | head -n1 | cut -d ' ' -f 2 | xargs -I {} bash -c 'rsync -avz blot:/var/www/blot/data/blogs/{} ~/Downloads/ && open ~/Downloads/{}'

