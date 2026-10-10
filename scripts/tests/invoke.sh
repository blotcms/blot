#!/bin/bash

# Set the optional test path
TEST_PATH=$1

# Set the optional test seed
TEST_SEED=$2

# Everything after the path (seed and/or flags such as --shard=/--exclude=)
# is forwarded verbatim to `node tests`, so a command printed by the runner
# for reproducing a CI shard actually reproduces it.
RUNNER_ARGS=""
if [ "$#" -gt 0 ]; then
  shift
  RUNNER_ARGS="$*"
fi

echo "Running tests in path: $TEST_PATH with args: $RUNNER_ARGS"

# Unique run ID so multiple invocations can run in parallel (containers named per run)
BLOT_TEST_ID="${BLOT_TEST_ID:-blot-test-$$-${RANDOM}}"
REDIS_CONTAINER="test-redis-${BLOT_TEST_ID}"
MINIO_CONTAINER="test-minio-${BLOT_TEST_ID}"
TEST_CONTAINER="test-runner-${BLOT_TEST_ID}"

# Image names
REDIS_IMAGE="redis:alpine"
# MinIO stands in for S3 in app/storage/tests/s3.js. MinIO no longer publishes
# images itself; this is a pinned build of the upstream release. Keep it in
# step with .github/workflows/node.yml and scripts/development/docker-compose.yml
MINIO_IMAGE="alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4"
MINIO_USER="blot-test"
MINIO_PASSWORD="blot-test-secret"
TEST_IMAGE="blot-tests"

# Paths (adjust as needed)
TESTS_DIR=$(dirname "$0") # Directory containing this script
APP_DIR=$(realpath "$TESTS_DIR/../../app")
CONFIG_DIR=$(realpath "$TESTS_DIR/../../config")
TEST_ENV_FILE="$TESTS_DIR/test.env"

# Stop and remove any existing containers
docker rm -f $REDIS_CONTAINER $MINIO_CONTAINER $TEST_CONTAINER 2>/dev/null || true

# Create test.env if it doesn't exist
if [ ! -f "$TEST_ENV_FILE" ]; then
  touch "$TEST_ENV_FILE"
fi

# Start Redis container
docker run -d \
  --name $REDIS_CONTAINER \
  --rm \
  $REDIS_IMAGE \
  sh -c "rm -f /data/dump.rdb && redis-server"

# Start MinIO container (as root so it can write to /data)
docker run -d \
  --name $MINIO_CONTAINER \
  --rm \
  --user root \
  -e MINIO_ROOT_USER=$MINIO_USER \
  -e MINIO_ROOT_PASSWORD=$MINIO_PASSWORD \
  $MINIO_IMAGE \
  server /data

# Build the test image. The Dockerfile needs TARGETPLATFORM to pick a
# Pandoc architecture. BuildKit sets this automatically; the classic
# builder does not, so pass it explicitly (this environment has no buildx).
case "$(uname -m)" in
  x86_64) TARGETPLATFORM="linux/amd64" ;;
  aarch64|arm64) TARGETPLATFORM="linux/arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

docker build \
  --target dev \
  --build-arg TARGETPLATFORM="$TARGETPLATFORM" \
  -t $TEST_IMAGE \
  $(realpath "$TESTS_DIR/../..")

# Wait for MinIO to answer its health check, like the CI workflow does. It
# isn't published on the host, so the check runs in a throwaway container from
# the test image, linked to MinIO the way the test container is.
MINIO_WAIT_SECONDS=30

if ! docker run --rm \
  --link $MINIO_CONTAINER:minio \
  --entrypoint node \
  $TEST_IMAGE \
  -e '
    const deadline = Date.now() + '"$MINIO_WAIT_SECONDS"' * 1000;
    function check() {
      require("http")
        .get("http://minio:9000/minio/health/live", (res) => {
          res.resume();
          if (res.statusCode === 200) process.exit(0);
          again();
        })
        .on("error", again);
    }
    function again() {
      if (Date.now() > deadline) process.exit(1);
      setTimeout(check, 500);
    }
    check();
  '; then
  echo "MinIO did not become ready within ${MINIO_WAIT_SECONDS}s" >&2
  docker logs $MINIO_CONTAINER >&2 || true
  docker stop $REDIS_CONTAINER $MINIO_CONTAINER 2>/dev/null || true
  exit 1
fi

# Run the test container
docker run --rm \
  --name $TEST_CONTAINER \
  --link $REDIS_CONTAINER:redis \
  --link $MINIO_CONTAINER:minio \
  --env-file "$TEST_ENV_FILE" \
  -e TEST_PATH="$TEST_PATH" \
  -e TEST_SEED="$TEST_SEED" \
  -e DEBUG="$DEBUG" \
  -e BLOT_REDIS_HOST="redis" \
  -e BLOT_HOST="localhost" \
  -e BLOT_TEST_S3_ENDPOINT="http://minio:9000" \
  -e BLOT_TEST_S3_KEY="$MINIO_USER" \
  -e BLOT_TEST_S3_SECRET="$MINIO_PASSWORD" \
  -v "$APP_DIR:/usr/src/app/app" \
  -v "$TESTS_DIR:/usr/src/app/tests" \
  -v "$CONFIG_DIR:/usr/src/app/config" \
  $TEST_IMAGE \
  sh -c "rm -rf /usr/src/app/data && mkdir /usr/src/app/data && node -v && npm -v && nyc --include $TEST_PATH node tests $TEST_PATH $RUNNER_ARGS"
TEST_EXIT=$?

# Stop Redis and MinIO containers
docker stop $REDIS_CONTAINER $MINIO_CONTAINER 2>/dev/null || true

exit $TEST_EXIT