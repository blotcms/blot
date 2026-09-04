#!/bin/bash

# Set the optional test path
TEST_PATH=$1

# Set the optional test seed
TEST_SEED=$2

echo "Running tests in path: $TEST_PATH with seed $TEST_SEED"

# Unique run ID so multiple invocations can run in parallel (containers named per run)
BLOT_TEST_ID="${BLOT_TEST_ID:-blot-test-$$-${RANDOM}}"
REDIS_CONTAINER="test-redis-${BLOT_TEST_ID}"
TEST_CONTAINER="test-runner-${BLOT_TEST_ID}"

# Image names
REDIS_IMAGE="redis:alpine"
TEST_IMAGE="blot-tests"

# Paths (adjust as needed)
TESTS_DIR=$(dirname "$0") # Directory containing this script
APP_DIR=$(realpath "$TESTS_DIR/../../app")
CONFIG_DIR=$(realpath "$TESTS_DIR/../../config")
TEST_ENV_FILE="$TESTS_DIR/test.env"

# Stop and remove any existing containers
docker rm -f $REDIS_CONTAINER $TEST_CONTAINER 2>/dev/null || true

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

# Run the test container
docker run --rm \
  --name $TEST_CONTAINER \
  --link $REDIS_CONTAINER:redis \
  --env-file "$TEST_ENV_FILE" \
  -e TEST_PATH="$TEST_PATH" \
  -e TEST_SEED="$TEST_SEED" \
  -e DEBUG="$DEBUG" \
  -e BLOT_REDIS_HOST="redis" \
  -e BLOT_HOST="localhost" \
  -v "$APP_DIR:/usr/src/app/app" \
  -v "$TESTS_DIR:/usr/src/app/tests" \
  -v "$CONFIG_DIR:/usr/src/app/config" \
  $TEST_IMAGE \
  sh -c "rm -rf /usr/src/app/data && mkdir /usr/src/app/data && node -v && npm -v && nyc --include $TEST_PATH node tests $TEST_PATH $TEST_SEED"
TEST_EXIT=$?

# Stop Redis container
docker stop $REDIS_CONTAINER 2>/dev/null || true

exit $TEST_EXIT