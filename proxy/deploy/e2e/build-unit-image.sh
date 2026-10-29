#!/usr/bin/env bash
#
# Build a stand-in unit image (unit/Dockerfile) on top of a proxy image built
# from a source tree by build-image.sh, which includes its rate-limit
# whitelist for the load generator. The proxy image goes in a repository of its
# own, because blue-green.sh removes the other tags of the repository it deploys.
# Anything after the tag goes to the unit's `docker build` (--label, --build-arg).
#
#   GENDEPS_MODULES=<dir with mustache and fs-extra in node_modules> \
#     build-unit-image.sh <source tree> <image tag> [docker build args]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${1:?usage: build-unit-image.sh <source tree> <image tag> [docker build args]}"
TAG="${2:?usage: build-unit-image.sh <source tree> <image tag> [docker build args]}"
shift 2

BASE="$(printf '%s' "${TAG%%:*}" | tr '/.' '--')-base:e2e"
bash "$HERE/build-image.sh" "$SRC" "$BASE"
docker build -f "$HERE/unit/Dockerfile" --build-arg "BASE=$BASE" "$@" -t "$TAG" "$HERE/unit"
