#!/usr/bin/env bash
# Prints the tag of the CI test image (the Dockerfile's `dev` target) for this
# checkout: ghcr.io/<owner>/blot:test-<hash of what the image is built from>.
# node.yml builds and pushes it when it doesn't exist yet; the test jobs and
# benchmarks.yml pull it. Bump BUILD_SETTINGS when you change how node.yml
# builds the image (compression, target, ...) to force a rebuild.
#
# Hashes the files next to this script's checkout, so node.yml can run a copy
# fetched with those files into another directory, before any checkout.
set -euo pipefail
BUILD_SETTINGS=zstd-1
cd "$(dirname "$0")/../../.."
HASH=$( (cat Dockerfile .dockerignore package.json; echo "$BUILD_SETTINGS") | sha256sum | cut -d ' ' -f 1)
echo "ghcr.io/${GITHUB_REPOSITORY_OWNER:-blotcms}/blot:test-$HASH"
