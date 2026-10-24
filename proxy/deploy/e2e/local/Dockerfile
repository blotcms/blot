# A Linux "runner" for running the deploy e2e on a machine that is not one
# (Docker Desktop on a Mac: no host networking on the Mac, bind mounts that
# are not ext4). It holds its own Docker daemon, so the proxy containers use
# --network host in THIS container's network namespace and bind-mount
# directories of its own filesystem, as on a GitHub runner. See local.sh.
FROM ubuntu:24.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      docker.io iptables iproute2 ca-certificates curl redis-tools openssl \
      util-linux sudo nodejs hostname procps git \
 && rm -rf /var/lib/apt/lists/*
