# TOXIPROXY_VERSION comes from config/versions.env (compose passes it).
ARG TOXIPROXY_VERSION
FROM ghcr.io/shopify/toxiproxy:${TOXIPROXY_VERSION}
# Base image ENTRYPOINT is /toxiproxy; CMD must be args only, e.g. -host=0.0.0.0 (default)
# Overriding CMD with /toxiproxy-server was wrong (no such path in scratch image) and prevented listening on 8474