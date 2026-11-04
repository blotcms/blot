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
POSTGRES_CONTAINER="test-postgres-${BLOT_TEST_ID}"
MINIO_CONTAINER="test-minio-${BLOT_TEST_ID}"
TEST_CONTAINER="test-runner-${BLOT_TEST_ID}"

# Versions (NODE_BASE, PANDOC_VERSION, POSTGRES_VERSION, MINIO_IMAGE) from config/versions.env
set -a; . "$(dirname "$0")/../../config/versions.env"; set +a

# Image names
REDIS_IMAGE="redis:alpine"
POSTGRES_IMAGE="postgres:${POSTGRES_VERSION}-alpine"
# MinIO stands in for S3: generated assets live only in the storage bucket, so
# every test run needs one. MinIO no longer publishes images itself; the image
# is a pinned build of the upstream release (MINIO_IMAGE in config/versions.env).
MINIO_USER="blot-test"
MINIO_PASSWORD="blot-test-secret"
# Created by the test runner (scripts/tests/util/bucket.js) when it starts
STORAGE_BUCKET="blot-test-storage"
TEST_IMAGE="blot-tests"

# Paths (adjust as needed)
TESTS_DIR=$(dirname "$0") # Directory containing this script
APP_DIR=$(realpath "$TESTS_DIR/../../app")
CONFIG_DIR=$(realpath "$TESTS_DIR/../../config")
TEST_ENV_FILE="$TESTS_DIR/test.env"

# Stop and remove any existing containers
docker rm -f $REDIS_CONTAINER $POSTGRES_CONTAINER $MINIO_CONTAINER $TEST_CONTAINER 2>/dev/null || true

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

# Start Postgres. The runner applies the schema to its empty database
docker run -d \
  --name $POSTGRES_CONTAINER \
  --rm \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=blot_test \
  $POSTGRES_IMAGE \
  -c fsync=off

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
  --build-arg NODE_BASE="$NODE_BASE" \
  --build-arg PANDOC_VERSION="$PANDOC_VERSION" \
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
  docker stop $REDIS_CONTAINER $POSTGRES_CONTAINER $MINIO_CONTAINER 2>/dev/null || true
  exit 1
fi

# -h: the image's first-start setup runs a server on its socket only
for i in $(seq 1 30); do
  docker exec $POSTGRES_CONTAINER pg_isready -h 127.0.0.1 -U postgres > /dev/null 2>&1 && break
  if [ "$i" = 30 ]; then
    echo "Postgres did not become ready" >&2
    docker stop $REDIS_CONTAINER $POSTGRES_CONTAINER $MINIO_CONTAINER 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

# Run the test container
docker run --rm \
  --name $TEST_CONTAINER \
  --link $REDIS_CONTAINER:redis \
  --link $POSTGRES_CONTAINER:postgres \
  --link $MINIO_CONTAINER:minio \
  --env-file "$TEST_ENV_FILE" \
  -e TEST_PATH="$TEST_PATH" \
  -e TEST_SEED="$TEST_SEED" \
  -e DEBUG="$DEBUG" \
  -e BLOT_REDIS_HOST="redis" \
  -e BLOT_POSTGRES_URL="postgres://postgres@postgres:5432/blot_test" \
  -e BLOT_HOST="localhost" \
  -e BLOT_STORAGE_BUCKET="$STORAGE_BUCKET" \
  -e BLOT_STORAGE_ENDPOINT="http://minio:9000" \
  -e BLOT_STORAGE_REGION="us-east-1" \
  -e BLOT_AWS_KEY="$MINIO_USER" \
  -e BLOT_AWS_SECRET="$MINIO_PASSWORD" \
  -v "$APP_DIR:/usr/src/app/app" \
  -v "$TESTS_DIR:/usr/src/app/tests" \
  -v "$CONFIG_DIR:/usr/src/app/config" \
  $TEST_IMAGE \
  sh -c "rm -rf /usr/src/app/data && mkdir /usr/src/app/data && node -v && npm -v && nyc --include $TEST_PATH node tests $TEST_PATH $RUNNER_ARGS"
TEST_EXIT=$?

# Stop Redis, Postgres and MinIO containers
docker stop $REDIS_CONTAINER $POSTGRES_CONTAINER $MINIO_CONTAINER 2>/dev/null || true

exit $TEST_EXIT