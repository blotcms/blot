# A stand-in for the airlock image: only what blue-green.sh looks at, a container
# that is healthy (Docker's HEALTHCHECK) and has the ports the unit's airlock
# publishes on 127.0.0.1. The real one needs Chromium and NET_ADMIN.
FROM alpine:3.22
HEALTHCHECK --interval=5s --timeout=3s CMD true
EXPOSE 9222 8888
CMD ["sleep", "infinity"]
